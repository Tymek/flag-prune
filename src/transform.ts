import { parse as parseWithBabel } from "@babel/parser"
import traverse, { type Binding, type NodePath } from "@babel/traverse"
import * as t from "@babel/types"
import { parse as parseWithRecast, print } from "recast"
import { constantOf, isRemovablePure, requiredEffects, staticIndex, staticMemberKey } from "./analysis.js"
import { validateConfig } from "./config.js"
import { buildMatchers, matchCall, matchValue, type FlagMatcher } from "./matchers.js"
import { simplifyPass } from "./simplify.js"
import type { FlagValue, TransformOptions, TransformReport, TransformResult } from "./types.js"

type BabelParserPlugins = NonNullable<NonNullable<Parameters<typeof parseWithBabel>[1]>["plugins"]>

function parserPluginsFor(filename?: string): BabelParserPlugins {
  const typescriptWithoutJsx = filename !== undefined && /\.(?:cts|mts|ts)$/i.test(filename)
  return [
    ...(typescriptWithoutJsx ? [] : ["jsx"]),
    "typescript",
    "decorators-legacy",
    "decoratorAutoAccessors",
    "importAttributes",
  ] as BabelParserPlugins
}

function normalizeBabelAstForRecast(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(normalizeBabelAstForRecast)
    return
  }
  if (value === null || typeof value !== "object") return
  const node = value as Record<string, unknown>
  if (node.type === "TSInterfaceHeritage" || node.type === "TSClassImplements") {
    node.type = "TSExpressionWithTypeArguments"
  }
  if (node.type === "TSTemplateLiteralType") {
    node.type = "TSLiteralType"
    node.literal = { type: "TemplateLiteral", quasis: node.quasis, expressions: node.types }
    delete node.quasis
    delete node.types
  }
  Object.values(node).forEach(normalizeBabelAstForRecast)
}

function parseSource(source: string, filename?: string): t.File {
  try {
    return parseWithRecast(source, {
      parser: {
        parse(code: string) {
          const ast = parseWithBabel(code, {
            sourceType: "unambiguous",
            ...(filename === undefined ? {} : { sourceFilename: filename }),
            plugins: parserPluginsFor(filename),
            attachComment: true,
            createParenthesizedExpressions: true,
            tokens: true,
          })
          normalizeBabelAstForRecast(ast)
          return ast
        },
      },
    }) as t.File
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

function preferredQuote(ast: t.File): "single" | "double" {
  let single = 0
  let double = 0
  t.traverseFast(ast, (node) => {
    if (!t.isStringLiteral(node)) return
    const raw = typeof node.extra?.raw === "string" ? node.extra.raw : undefined
    if (raw?.startsWith("'")) single += 1
    else if (raw?.startsWith('"')) double += 1
  })
  return single > double ? "single" : "double"
}

interface ReplacementState {
  matchers: FlagMatcher[]
  matchedBindings: Set<Binding>
  constantBindings: Map<Binding, FlagValue>
  report: TransformReport
}

function literalFor(value: FlagValue): t.Expression {
  if (value === null) return t.nullLiteral()
  if (typeof value === "string") return t.stringLiteral(value)
  if (typeof value === "number") {
    return value < 0 || Object.is(value, -0)
      ? t.unaryExpression("-", t.numericLiteral(Math.abs(value)))
      : t.numericLiteral(value)
  }
  if (typeof value === "boolean") return t.booleanLiteral(value)
  if (Array.isArray(value)) return t.arrayExpression(value.map(literalFor))
  return t.objectExpression(
    Object.entries(value).map(([key, entry]) => t.objectProperty(objectKeyFor(key), literalFor(entry))),
  )
}

function objectKeyFor(key: string): t.Identifier | t.StringLiteral {
  return /^[$A-Z_a-z][$\w]*$/.test(key) ? t.identifier(key) : t.stringLiteral(key)
}

function isStructuredValue(value: FlagValue): value is FlagValue[] | { [key: string]: FlagValue } {
  return typeof value === "object" && value !== null
}

/** Read a static property or index of a structured flag value from a member access node. */
function structuredEntry(
  value: FlagValue[] | { [key: string]: FlagValue },
  node: t.MemberExpression | t.OptionalMemberExpression,
): FlagValue | undefined {
  if (Array.isArray(value)) {
    const index = staticIndex(node)
    return index !== undefined && index < value.length ? value[index] : undefined
  }
  const key = staticMemberKey(node)
  return key !== undefined && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
}

function flagValueOf(matcher: FlagMatcher): FlagValue {
  return matcher.flag.value === undefined ? true : matcher.flag.value
}

function recordConstantBinding(
  path: NodePath<t.Expression>,
  value: FlagValue,
  state: ReplacementState,
): void {
  const parent = path.parentPath
  if (parent.isVariableDeclarator() && parent.node.init === path.node && t.isIdentifier(parent.node.id)) {
    const binding = parent.scope.getBinding(parent.node.id.name)
    if (binding?.constant === true) state.constantBindings.set(binding, value)
  }
}

function disableObjectShorthand(path: NodePath<t.Expression>): void {
  const parent = path.parentPath
  if (parent.isObjectProperty() && parent.node.shorthand && parent.node.value === path.node) {
    parent.node.shorthand = false
  }
}

function argumentEffects(path: NodePath<t.Expression>): t.Expression[] {
  if (isRemovablePure(path)) return []
  if (path.isArrayExpression()) {
    const effects: t.Expression[] = []
    for (const element of path.get("elements")) {
      if (element.node === null) continue
      if (element.isSpreadElement()) {
        effects.push(t.arrayExpression([t.spreadElement(element.node.argument)]))
      } else if (element.isExpression()) {
        effects.push(...argumentEffects(element))
      }
    }
    return effects
  }
  if (path.isObjectExpression()) {
    const effects: t.Expression[] = []
    for (const property of path.get("properties")) {
      if (property.isSpreadElement()) {
        effects.push(t.objectExpression([t.spreadElement(property.node.argument)]))
        continue
      }
      if (property.node.computed) {
        const key = property.get("key")
        if (key.isExpression()) effects.push(...argumentEffects(key))
      }
      if (property.isObjectProperty()) {
        const value = property.get("value")
        if (value.isExpression()) effects.push(...argumentEffects(value))
      }
    }
    return effects
  }
  return [path.node]
}

function replacementFor(path: NodePath<t.Expression>, matcher: FlagMatcher, state: ReplacementState): boolean {
  if (matcher.kind !== "value" || !matchValue(path, matcher)) return false
  const value = flagValueOf(matcher)
  recordConstantBinding(path, value, state)
  const replacement = literalFor(value)
  t.inheritsComments(replacement, path.node)
  disableObjectShorthand(path)
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
  const value = flagValueOf(matcher)
  recordConstantBinding(path, value, state)
  const effects: t.Expression[] = []
  for (const argumentPath of path.get("arguments").slice(matcher.arguments.length)) {
    if (argumentPath.isSpreadElement()) {
      effects.push(t.arrayExpression([t.spreadElement(argumentPath.node.argument)]))
    } else if (argumentPath.isExpression()) {
      effects.push(...argumentEffects(argumentPath))
    }
  }
  const literal = literalFor(value)
  const replacement = effects.length === 0 ? literal : t.sequenceExpression([...effects, literal])
  t.inheritsComments(replacement, path.node)
  path.replaceWith(replacement)
  if (matcher.binding !== undefined) state.matchedBindings.add(matcher.binding)
  state.report.flagsReplaced += 1
  state.report.effectsPreserved += effects.length
  return true
}

function inlineConstantBindings(state: ReplacementState): void {
  for (const [binding, value] of state.constantBindings) {
    if (isStructuredValue(value)) inlineStructuredBinding(binding, value, state)
    else inlineScalarBinding(binding, value, state)
    state.matchedBindings.add(binding)
  }
}

function inlineScalarBinding(binding: Binding, value: FlagValue, state: ReplacementState): void {
  for (const reference of binding.referencePaths) {
    if (
      reference.removed ||
      !reference.isReferencedIdentifier() ||
      reference.parentPath.isExportSpecifier() ||
      reference.parentPath.isTSTypeQuery()
    ) {
      continue
    }
    const replacement = literalFor(value)
    t.inheritsComments(replacement, reference.node)
    disableObjectShorthand(reference as NodePath<t.Expression>)
    reference.replaceWith(replacement)
    state.report.expressionsFolded += 1
  }
}

/**
 * Fold static member and index reads of an object or array flag value. The
 * declaration is left in place so object identity is preserved for whole-value
 * uses; unused declarations are removed later by binding cleanup.
 */
function inlineStructuredBinding(
  binding: Binding,
  value: FlagValue[] | { [key: string]: FlagValue },
  state: ReplacementState,
): void {
  for (const reference of binding.referencePaths) {
    if (
      reference.removed ||
      !reference.isReferencedIdentifier() ||
      reference.parentPath.isExportSpecifier() ||
      reference.parentPath.isTSTypeQuery()
    ) {
      continue
    }
    const parent = reference.parentPath
    if (
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.node.object === reference.node
    ) {
      const entry = structuredEntry(value, parent.node)
      if (entry !== undefined) {
        const replacement = literalFor(entry)
        t.inheritsComments(replacement, parent.node)
        disableObjectShorthand(parent as NodePath<t.Expression>)
        parent.replaceWith(replacement)
        state.report.expressionsFolded += 1
      }
    }
  }
}

function replaceFlags(ast: t.File, matchers: FlagMatcher[], report: TransformReport): Set<Binding> {
  const state: ReplacementState = { matchers, matchedBindings: new Set(), constantBindings: new Map(), report }
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
  inlineConstantBindings(state)
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
  removeSideEffectImports: boolean,
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
    if (statementPath.node.specifiers.length === 0 && removeSideEffectImports) {
      moveImportComments(statementPath)
      statementPath.remove()
    } else {
      const replacement = t.cloneNode(statementPath.node, true, true)
      const recastStatement = statementPath.node as t.ImportDeclaration & { comments?: t.Comment[] }
      const recastReplacement = replacement as t.ImportDeclaration & { comments?: t.Comment[] }
      if (recastStatement.comments !== undefined) recastReplacement.comments = recastStatement.comments
      statementPath.replaceWith(replacement)
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
      if (binding?.referenced === true || binding?.constant !== true) return
      const declaration = path.parentPath
      if (!declaration.isVariableDeclaration()) return
      const initializer = path.get("init")
      if (initializer.node !== null && initializer.isExpression() && !isRemovablePure(initializer)) {
        if (declaration.node.declarations.length !== 1) return
        if (!declaration.parentPath.isProgram() && !declaration.parentPath.isBlockStatement()) return
        const effects = constantOf(initializer.node) === "unknown" ? [initializer.node] : requiredEffects(initializer.node)
        declaration.replaceWithMultiple(effects.map((effect) => t.expressionStatement(effect)))
        report.effectsPreserved += effects.length
      } else if (declaration.node.declarations.length === 1) {
        declaration.remove()
      } else {
        path.remove()
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
    converged: true,
  }
}

function preferredLineTerminator(source: string): "\n" | "\r\n" | "\r" {
  const firstTerminator = /\r\n|\r|\n/.exec(source)
  return (firstTerminator?.[0] as "\n" | "\r\n" | "\r" | undefined) ?? "\n"
}

export function transform(source: string, options: TransformOptions): TransformResult {
  const config = validateConfig(options)
  const report = createReport(options.filename)
  const ast = parseSource(source, options.filename)
  const quote = preferredQuote(ast)
  const initialProgramPath = programPathFor(ast)
  const matcherSet = buildMatchers(initialProgramPath, config.flags)
  const matchedBindings = replaceFlags(ast, matcherSet.matchers, report)
  const maxPasses = config.maxPasses ?? 20
  let totalChanges = report.flagsReplaced

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    programPathFor(ast).scope.crawl()
    const changes = simplifyPass(
      ast,
      {
        commentPolicy: config.commentPolicy ?? "report",
        simplifyEffectfulConditions: config.simplifyEffectfulConditions ?? true,
        solverVariableLimit: config.solverVariableLimit ?? 8,
      },
      report,
    )
    totalChanges += changes
    report.passes = pass
    if (changes === 0) break
    if (pass === maxPasses) {
      report.converged = false
      report.warnings.push(`Fixed point not reached after ${maxPasses} passes`)
    }
  }

  if (config.removeUnusedImports ?? true) {
    cleanupImports(
      programPathFor(ast),
      matcherSet.importCandidates,
      config.removeSideEffectImports ?? false,
      report,
    )
  }
  cleanupBindings(ast, matchedBindings, report)
  totalChanges += report.importsRemoved + report.bindingsRemoved

  if (totalChanges === 0) return { code: source, changed: false, report }

  const lineTerminator = preferredLineTerminator(source)
  const generated = print(ast, { reuseWhitespace: true, quote, lineTerminator }).code
  const code = generated.length === 0 || generated.endsWith(lineTerminator)
    ? generated
    : `${generated}${lineTerminator}`
  if (config.verify?.parse !== false) parseSource(code, options.filename)

  return { code, changed: code !== source, report }
}
