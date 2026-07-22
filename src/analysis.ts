import type { Binding, NodePath, Scope } from "@babel/traverse"
import * as t from "@babel/types"
import type { Analysis, ConstantBoolean, Purity } from "./types.js"

function combinePurity(...values: Purity[]): Purity {
  if (values.includes("effectful")) return "effectful"
  if (values.includes("unknown")) return "unknown"
  return "pure"
}

function declarationPrecedes(binding: Binding, position: number | null | undefined): boolean {
  if (binding.kind === "module" || binding.kind === "param" || position == null) return true
  const declarationPosition = binding.identifier.start
  return declarationPosition == null || declarationPosition <= position
}

function unwrap(node: t.Expression): t.Expression {
  if (
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSNonNullExpression(node) ||
    t.isTypeCastExpression(node) ||
    t.isParenthesizedExpression(node)
  ) {
    return unwrap(node.expression)
  }
  return node
}

export function constantOf(input: t.Expression): ConstantBoolean {
  const node = unwrap(input)
  if (t.isBooleanLiteral(node)) return node.value
  if (t.isSequenceExpression(node)) return constantOf(node.expressions.at(-1)!)
  if (t.isUnaryExpression(node, { operator: "!" })) {
    const argument = constantOf(node.argument as t.Expression)
    return argument === "unknown" ? "unknown" : !argument
  }
  if (t.isBinaryExpression(node) && ["===", "!==", "==", "!="].includes(node.operator)) {
    if (t.isBooleanLiteral(node.left) && t.isBooleanLiteral(node.right)) {
      const equal = node.left.value === node.right.value
      return node.operator === "===" || node.operator === "==" ? equal : !equal
    }
  }
  if (t.isLogicalExpression(node)) {
    const left = constantOf(node.left)
    const right = constantOf(node.right)
    if (node.operator === "&&") {
      if (left === false) return false
      if (left === true) return right
      if (right === false) return false
    }
    if (node.operator === "||") {
      if (left === true) return true
      if (left === false) return right
      if (right === true) return true
    }
  }
  if (t.isConditionalExpression(node)) {
    const test = constantOf(node.test)
    if (test === true) return constantOf(node.consequent)
    if (test === false) return constantOf(node.alternate)
  }
  return "unknown"
}

function purityOfNode(node: t.Expression, scope: Scope, position: number | null | undefined): Purity {
  const value = unwrap(node)
  if (
    t.isBooleanLiteral(value) ||
    t.isStringLiteral(value) ||
    t.isNumericLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isNullLiteral(value) ||
    t.isRegExpLiteral(value) ||
    t.isFunctionExpression(value) ||
    t.isArrowFunctionExpression(value)
  ) {
    return "pure"
  }
  if (t.isIdentifier(value)) {
    const binding = scope.getBinding(value.name)
    return binding !== undefined && declarationPrecedes(binding, position) ? "pure" : "unknown"
  }
  if (t.isUnaryExpression(value)) {
    if (value.operator === "delete") return "effectful"
    if (value.operator === "typeof" && t.isIdentifier(value.argument) && scope.getBinding(value.argument.name) === undefined) {
      return "pure"
    }
    return purityOfNode(value.argument as t.Expression, scope, position)
  }
  if (t.isSequenceExpression(value)) {
    return combinePurity(...value.expressions.map((expression) => purityOfNode(expression, scope, position)))
  }
  if (t.isLogicalExpression(value) || t.isBinaryExpression(value)) {
    return combinePurity(
      purityOfNode(value.left as t.Expression, scope, position),
      purityOfNode(value.right, scope, position),
    )
  }
  if (t.isConditionalExpression(value)) {
    return combinePurity(
      purityOfNode(value.test, scope, position),
      purityOfNode(value.consequent, scope, position),
      purityOfNode(value.alternate, scope, position),
    )
  }
  if (t.isTemplateLiteral(value)) {
    return combinePurity(
      ...value.expressions.map((expression) =>
        t.isExpression(expression) ? purityOfNode(expression, scope, position) : "unknown",
      ),
    )
  }
  if (t.isAwaitExpression(value) || t.isYieldExpression(value)) return "effectful"
  if (
    t.isCallExpression(value) ||
    t.isOptionalCallExpression(value) ||
    t.isNewExpression(value) ||
    t.isAssignmentExpression(value) ||
    t.isUpdateExpression(value) ||
    t.isTaggedTemplateExpression(value)
  ) {
    return "effectful"
  }
  return "unknown"
}

export function analyze(path: NodePath<t.Expression>): Analysis {
  return {
    constant: constantOf(path.node),
    purity: purityOfNode(path.node, path.scope, path.node.start),
  }
}

export function purityOf(path: NodePath<t.Expression>): Purity {
  return purityOfNode(path.node, path.scope, path.node.start)
}

export function isRemovablePure(path: NodePath<t.Expression>): boolean {
  return purityOf(path) === "pure"
}

function hasBooleanAnnotation(identifier: t.Identifier): boolean {
  const annotation = identifier.typeAnnotation?.typeAnnotation
  return annotation !== undefined && t.isTSBooleanKeyword(annotation)
}

function bindingIsBoolean(binding: Binding, scope: Scope, seen: Set<Binding>): boolean {
  if (seen.has(binding)) return false
  seen.add(binding)
  if (hasBooleanAnnotation(binding.identifier)) return true
  if (binding.path.isVariableDeclarator() && binding.path.node.init !== null && t.isExpression(binding.path.node.init)) {
    return isBooleanNode(binding.path.node.init, scope, seen)
  }
  return false
}

function isBooleanNode(node: t.Expression, scope: Scope, seen: Set<Binding>): boolean {
  const value = unwrap(node)
  if (t.isBooleanLiteral(value) || t.isUnaryExpression(value, { operator: "!" })) return true
  if (t.isBinaryExpression(value) && ["===", "!==", "==", "!=", "<", "<=", ">", ">="].includes(value.operator)) {
    return true
  }
  if (t.isLogicalExpression(value)) {
    return isBooleanNode(value.left, scope, seen) && isBooleanNode(value.right, scope, seen)
  }
  if (t.isConditionalExpression(value)) {
    return isBooleanNode(value.consequent, scope, seen) && isBooleanNode(value.alternate, scope, seen)
  }
  if (t.isIdentifier(value)) {
    const binding = scope.getBinding(value.name)
    return binding !== undefined && bindingIsBoolean(binding, scope, seen)
  }
  if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node) || t.isTSSatisfiesExpression(node)) {
    return t.isTSBooleanKeyword(node.typeAnnotation)
  }
  return false
}

export function isBoolean(path: NodePath<t.Expression>): boolean {
  return isBooleanNode(path.node, path.scope, new Set())
}

function isStableNode(node: t.Expression, scope: Scope, position: number | null | undefined): boolean {
  const value = unwrap(node)
  if (t.isIdentifier(value)) {
    const binding = scope.getBinding(value.name)
    return binding !== undefined && binding.constant && declarationPrecedes(binding, position)
  }
  if (t.isBooleanLiteral(value)) return true
  if (t.isUnaryExpression(value, { operator: "!" })) {
    return t.isExpression(value.argument) && isStableNode(value.argument, scope, position)
  }
  if (t.isLogicalExpression(value)) {
    return isStableNode(value.left, scope, position) && isStableNode(value.right, scope, position)
  }
  return false
}

export function isPureStableBoolean(path: NodePath<t.Expression>): boolean {
  return isBoolean(path) && isRemovablePure(path) && isStableNode(path.node, path.scope, path.node.start)
}

export function requiredEffects(node: t.Expression): t.Expression[] {
  const value = unwrap(node)
  if (t.isBooleanLiteral(value)) return []
  if (t.isSequenceExpression(value)) {
    return [...value.expressions.slice(0, -1), ...requiredEffects(value.expressions.at(-1)!)]
  }
  if (t.isUnaryExpression(value, { operator: "!" }) && t.isExpression(value.argument)) {
    return requiredEffects(value.argument)
  }
  return [node]
}

export function sequenceWithResult(effects: t.Expression[], result: t.Expression): t.Expression {
  if (effects.length === 0) return result
  const expressions = [...effects, result]
  return expressions.length === 1 ? expressions[0]! : t.sequenceExpression(expressions)
}
