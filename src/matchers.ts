import type { Binding, NodePath } from "@babel/traverse"
import * as t from "@babel/types"
import type { FlagArgument, FlagDefinition } from "./types.js"

interface BaseMatcher {
  flag: FlagDefinition
  root: string
  binding: Binding | undefined
  importSpecifier?: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier
}

interface ValueMatcher extends BaseMatcher {
  kind: "value"
  properties: string[]
}

interface CallMatcher extends BaseMatcher {
  kind: "call"
  properties: string[]
  arguments: FlagArgument[]
}

export type FlagMatcher = ValueMatcher | CallMatcher

export interface MatcherSet {
  matchers: FlagMatcher[]
  importCandidates: Set<t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier>
}

interface RootTarget {
  root: string
  properties: string[]
  specifier?: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier
}

function importedName(specifier: t.ImportSpecifier): string {
  return t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value
}

function importedTargets(program: t.Program, moduleName: string, exportedName: string): RootTarget[] {
  const targets: RootTarget[] = []
  for (const statement of program.body) {
    if (!t.isImportDeclaration(statement) || statement.source.value !== moduleName) continue
    for (const specifier of statement.specifiers) {
      if (t.isImportSpecifier(specifier) && importedName(specifier) === exportedName) {
        targets.push({ root: specifier.local.name, properties: [], specifier })
      } else if (t.isImportDefaultSpecifier(specifier) && exportedName === "default") {
        targets.push({ root: specifier.local.name, properties: [], specifier })
      } else if (t.isImportNamespaceSpecifier(specifier)) {
        targets.push({ root: specifier.local.name, properties: [exportedName], specifier })
      }
    }
  }
  return targets
}

function staticParts(selector: string): [string, ...string[]] {
  return selector.split(".") as [string, ...string[]]
}

function localTarget(program: t.Program, root: string, properties: string[]): RootTarget {
  for (const statement of program.body) {
    if (!t.isImportDeclaration(statement)) continue
    const specifier = statement.specifiers.find((candidate) => candidate.local.name === root)
    if (specifier !== undefined) return { root, properties, specifier }
  }
  return { root, properties }
}

function targetsForFlag(programPath: NodePath<t.Program>, flag: FlagDefinition): RootTarget[] {
  if (flag.call !== undefined) {
    const [root, ...properties] = staticParts(flag.call)
    if (flag.module !== undefined) {
      return importedTargets(programPath.node, flag.module, root).map((target) => ({
        ...target,
        properties: [...target.properties, ...properties],
      }))
    }
    return [localTarget(programPath.node, root, properties)]
  }

  if (flag.module !== undefined && flag.export !== undefined) {
    return importedTargets(programPath.node, flag.module, flag.export)
  }

  const root = flag.identifier ?? flag.export
  return root === undefined ? [] : [{ root, properties: [] }]
}

export function buildMatchers(programPath: NodePath<t.Program>, flags: FlagDefinition[]): MatcherSet {
  const matchers: FlagMatcher[] = []
  const importCandidates = new Set<
    t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier
  >()

  for (const flag of flags) {
    for (const target of targetsForFlag(programPath, flag)) {
      const base: BaseMatcher = {
        flag,
        root: target.root,
        binding: programPath.scope.getBinding(target.root),
        ...(target.specifier === undefined ? {} : { importSpecifier: target.specifier }),
      }
      if (target.specifier !== undefined) importCandidates.add(target.specifier)

      if (flag.call !== undefined) {
        matchers.push({
          ...base,
          kind: "call",
          properties: target.properties,
          arguments: flag.arguments ?? [],
        })
      } else {
        matchers.push({
          ...base,
          kind: "value",
          properties: [...target.properties, ...(flag.path ?? [])],
        })
      }
    }
  }

  return { matchers, importCandidates }
}

interface StaticAccess {
  root: string
  properties: string[]
}

function staticProperty(node: t.MemberExpression | t.OptionalMemberExpression): string | undefined {
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name
  if (node.computed && t.isStringLiteral(node.property)) return node.property.value
  return undefined
}

function staticAccess(node: t.Expression | t.V8IntrinsicIdentifier): StaticAccess | undefined {
  if (t.isIdentifier(node)) return { root: node.name, properties: [] }
  if (t.isThisExpression(node)) return { root: "this", properties: [] }
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return undefined
  const property = staticProperty(node)
  if (property === undefined || t.isSuper(node.object)) return undefined
  const parent = staticAccess(node.object)
  if (parent === undefined) return undefined
  return {
    root: parent.root,
    properties: [...parent.properties, property],
  }
}

function sameProperties(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function bindingMatches(path: NodePath, access: StaticAccess, matcher: FlagMatcher): boolean {
  if (access.root !== matcher.root) return false
  if (matcher.root === "this") return true
  const binding = path.scope.getBinding(access.root)
  if (matcher.binding !== undefined) return binding === matcher.binding
  return (matcher.kind === "call" && matcher.properties.length > 0) || binding === undefined
}

function argumentMatches(
  node: t.Expression | t.SpreadElement | t.JSXNamespacedName | t.ArgumentPlaceholder,
  expected: FlagArgument,
): boolean {
  if (expected === null) return t.isNullLiteral(node)
  if (typeof expected === "string") return t.isStringLiteral(node, { value: expected })
  if (typeof expected === "number") {
    if (t.isNumericLiteral(node, { value: expected })) return true
    return (
      expected < 0 &&
      t.isUnaryExpression(node, { operator: "-" }) &&
      t.isNumericLiteral(node.argument, { value: -expected })
    )
  }
  return t.isBooleanLiteral(node, { value: expected })
}

export function matchValue(path: NodePath<t.Expression>, matcher: ValueMatcher): boolean {
  if (matcher.properties.length === 0) {
    if (!path.isIdentifier({ name: matcher.root }) || !path.isReferencedIdentifier()) return false
    return path.scope.getBinding(matcher.root) === matcher.binding
  }
  if (!path.isMemberExpression() && !path.isOptionalMemberExpression()) return false
  const access = staticAccess(path.node)
  if (access === undefined || !bindingMatches(path, access, matcher)) return false
  return sameProperties(access.properties, matcher.properties)
}

export function matchCall(
  path: NodePath<t.CallExpression | t.OptionalCallExpression>,
  matcher: CallMatcher,
): boolean {
  const callee = path.node.callee
  if (t.isV8IntrinsicIdentifier(callee) || t.isSuper(callee) || t.isImport(callee)) return false
  const access = staticAccess(callee)
  if (access === undefined || !bindingMatches(path, access, matcher)) return false
  if (!sameProperties(access.properties, matcher.properties)) return false
  if (path.node.arguments.length < matcher.arguments.length) return false
  return matcher.arguments.every((expected, index) => argumentMatches(path.node.arguments[index]!, expected))
}
