import generate from "@babel/generator"
import { parse } from "@babel/parser"
import traverse, { type Binding, type NodePath } from "@babel/traverse"
import * as t from "@babel/types"
import { isRemovablePure } from "./analysis.js"
import { validateConfig } from "./config.js"
import { buildMatchers, matchCall, matchValue, type FlagMatcher } from "./matchers.js"
import { simplifyPass } from "./simplify.js"
import type { TransformOptions, TransformReport, TransformResult } from "./types.js"

const parserPlugins = [
  "jsx",
  "typescript",
  "decorators-legacy",
  "decoratorAutoAccessors",
  "importAttributes",
] as const

function parseSource(source: string, filename?: string): t.File {
  try {
    return parse(source, {
      sourceType: "unambiguous",
      ...(filename === undefined ? {} : { sourceFilename: filename }),
      plugins: [...parserPlugins] as any,
      attachComment: true,
      createParenthesizedExpressions: true,
    })
  } catch (error) {
    const prefix = filename === undefined ? "Unable to parse source" : `Unable to parse ${filename}`
    throw new SyntaxError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function programPathFor(ast: t.File): NodePath<t.Program> {
  let result: NodePath<t.Program> | undefined
  traverse(ast, {
    Program(path) {
      result = path
      path.stop()
    },
  })
  if (result === undefined) throw new Error("Parser did not produce a Program")
  return result
}

interface ReplacementState {
  matchers: FlagMatcher[]
  matchedBindings: Set<Binding>
  report: TransformReport
}

function replacementFor(path: NodePath<t.Expression>, matcher: FlagMatcher, state: ReplacementState): boolean {
  if (matcher.kind !== "value" || !matchValue(path, matcher)) return false
  const replacement = t.booleanLiteral(matcher.flag.value)
  t.inheritsComments(replacement, path.node)
  path.replaceWith(replacement)
  if (matcher.binding !== undefined) state.matchedBindings.add(matcher.binding)
  state.report.flagsReplaced += 1
  return true
}

function callReplacement(
  path: NodePath<t.CallExpression | t.OptionalCallExpression>,
  matcher: FlagMatcher,
  state: ReplacementState,
): boolean {
  if (matcher.kind !== "call" || !matchCall(path, matcher)) return false
  const replacement = t.booleanLiteral(matcher.flag.value)
  t.inheritsComments(replacement, path.node)
  path.replaceWith(replacement)
  if (matcher.binding !== undefined) state.matchedBindings.add(matcher.binding)
  state.report.flagsReplaced += 1
  return true
}

function replaceFlags(ast: t.File, matchers: FlagMatcher[], report: TransformReport): Set<Binding> {
  const state: ReplacementState = { matchers, matchedBindings: new Set(), report }
  traverse(ast, {
    CallExpression: {
      exit(path) {
        for (const matcher of state.matchers) {
          if (callReplacement(path, matcher, state)) break
        }
      },
    },
    OptionalCallExpression: {
      exit(path) {
        for (const matcher of state.matchers) {
          if (callReplacement(path, matcher, state)) break
        }
      },
    },
    MemberExpression: {
      exit(path) {
        for (const matcher of state.matchers) {
          if (replacementFor(path as NodePath<t.Expression>, matcher, state)) break
        }
      },
    },
    OptionalMemberExpression: {
      exit(path) {
        for (const matcher of state.matchers) {
          if (replacementFor(path as NodePath<t.Expression>, matcher, state)) break
        }
      },
    },
    Identifier: {
      exit(path) {
        for (const matcher of state.matchers) {
          if (replacementFor(path as NodePath<t.Expression>, matcher, state)) break
        }
      },
    },
  })
  return state.matchedBindings
}

function moveImportComments(declarationPath: NodePath<t.ImportDeclaration>): void {
  const comments = [
    ...(declarationPath.node.leadingComments ?? []),
    ...(declarationPath.node.innerComments ?? []),
    ...(declarationPath.node.trailingComments ?? []),
  ]
  if (comments.length === 0) return
  const sibling = declarationPath.getNextSibling()
  if (sibling.node != null) {
    sibling.node.leadingComments = [...comments, ...(sibling.node.leadingComments ?? [])]
  } else {
    declarationPath.parentPath.node.trailingComments = [
      ...(declarationPath.parentPath.node.trailingComments ?? []),
      ...comments,
    ]
  }
}

function cleanupImports(
  programPath: NodePath<t.Program>,
  candidates: Set<t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier>,
  report: TransformReport,
): void {
  programPath.scope.crawl()
  for (const statementPath of programPath.get("body")) {
    if (!statementPath.isImportDeclaration()) continue
    const originalCount = statementPath.node.specifiers.length
    statementPath.node.specifiers = statementPath.node.specifiers.filter((specifier) => {
      if (!candidates.has(specifier)) return true
      const binding = programPath.scope.getBinding(specifier.local.name)
      return binding?.referenced === true
    })
    const removed = originalCount - statementPath.node.specifiers.length
    if (removed === 0) continue
    report.importsRemoved += removed
    if (statementPath.node.specifiers.length === 0) {
      moveImportComments(statementPath)
      statementPath.remove()
    }
  }
}

function cleanupBindings(
  ast: t.File,
  matchedBindings: Set<Binding>,
  report: TransformReport,
): void {
  const identifiers = new Set([...matchedBindings].map((binding) => binding.identifier))
  if (identifiers.size === 0) return
  const programPath = programPathFor(ast)
  programPath.scope.crawl()
  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !identifiers.has(path.node.id)) return
      const binding = path.scope.getBinding(path.node.id.name)
      if (binding?.referenced === true) return
      const declaration = path.parentPath
      if (!declaration.isVariableDeclaration() || declaration.node.declarations.length !== 1) return
      const initializer = path.get("init")
      if (initializer.node !== null && initializer.isExpression() && !isRemovablePure(initializer)) {
        if (!declaration.parentPath.isProgram() && !declaration.parentPath.isBlockStatement()) return
        declaration.replaceWith(t.expressionStatement(initializer.node))
        report.effectsPreserved += 1
      } else {
        declaration.remove()
      }
      report.bindingsRemoved += 1
    },
  })
}

function createReport(filename?: string): TransformReport {
  return {
    ...(filename === undefined ? {} : { filename }),
    flagsReplaced: 0,
    expressionsFolded: 0,
    deadBranchesRemoved: 0,
    unreachableStatementsRemoved: 0,
    importsRemoved: 0,
    bindingsRemoved: 0,
    effectsPreserved: 0,
    removedComments: [],
    warnings: [],
    passes: 0,
  }
}

export function transform(source: string, options: TransformOptions): TransformResult {
  const config = validateConfig(options)
  const report = createReport(options.filename)
  const ast = parseSource(source, options.filename)
  const initialProgramPath = programPathFor(ast)
  const matcherSet = buildMatchers(initialProgramPath, config.flags)
  const matchedBindings = replaceFlags(ast, matcherSet.matchers, report)
  const maxPasses = config.maxPasses ?? 20

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    programPathFor(ast).scope.crawl()
    const changes = simplifyPass(
      ast,
      {
        commentPolicy: config.commentPolicy ?? "report",
        preserveEffects: config.preserveEffects ?? true,
        solverVariableLimit: config.solverVariableLimit ?? 8,
      },
      report,
    )
    report.passes = pass
    if (changes === 0) break
    if (pass === maxPasses) report.warnings.push(`Fixed point not reached after ${maxPasses} passes`)
  }

  if (config.removeUnusedImports ?? true) {
    cleanupImports(programPathFor(ast), matcherSet.importCandidates, report)
  }
  cleanupBindings(ast, matchedBindings, report)

  const generated = generate(ast, {
    comments: true,
    compact: false,
    concise: false,
    retainLines: false,
  }).code
  const code = generated.length === 0 ? "" : `${generated}\n`
  if (config.verify?.parse !== false) parseSource(code, options.filename)

  return { code, changed: code !== source, report }
}
