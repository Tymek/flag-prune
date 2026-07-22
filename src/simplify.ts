import type { NodePath } from "@babel/traverse"
import traverse from "@babel/traverse"
import * as t from "@babel/types"
import {
  constantOf,
  isBoolean,
  isPureStableBoolean,
  isRemovablePure,
  requiredEffects,
  sequenceWithResult,
} from "./analysis.js"
import type { CommentPolicy, TransformReport } from "./types.js"

export interface SimplifyOptions {
  commentPolicy: CommentPolicy
  preserveEffects: boolean
  solverVariableLimit: number
}

interface PassState {
  changes: number
  options: SimplifyOptions
  report: TransformReport
}

function expressionPath(path: NodePath, key: string): NodePath<t.Expression> {
  return path.get(key) as NodePath<t.Expression>
}

function replaceExpression(path: NodePath<t.Expression>, replacement: t.Expression, state: PassState): void {
  if (t.isNodesEquivalent(path.node, replacement)) return
  t.inheritsComments(replacement, path.node)
  path.replaceWith(replacement)
  state.changes += 1
  state.report.expressionsFolded += 1
}

function conditionEffects(path: NodePath<t.Expression>, state: PassState): t.Expression[] | undefined {
  if (isRemovablePure(path)) return []
  if (!state.options.preserveEffects) {
    const location = path.node.loc?.start
    const suffix = location === undefined ? "" : ` at ${location.line}:${location.column + 1}`
    const warning = `Skipped constant condition with required evaluation${suffix}`
    if (!state.report.warnings.includes(warning)) state.report.warnings.push(warning)
    return undefined
  }
  const effects = requiredEffects(path.node)
  if (effects.length > 0) state.report.effectsPreserved += 1
  return effects
}

function evaluationThen(
  path: NodePath<t.Expression>,
  result: t.Expression,
  state: PassState,
  knownConstant: boolean,
): t.Expression | undefined {
  if (isRemovablePure(path)) return result
  if (!state.options.preserveEffects) return undefined
  const effects = knownConstant ? requiredEffects(path.node) : [path.node]
  if (effects.length > 0) state.report.effectsPreserved += 1
  return sequenceWithResult(effects, result)
}

function sameExpression(left: t.Expression, right: t.Expression): boolean {
  return t.isNodesEquivalent(left, right)
}

function logicalComplement(left: t.Expression, right: t.Expression): boolean {
  return (
    (t.isUnaryExpression(left, { operator: "!" }) &&
      t.isExpression(left.argument) &&
      sameExpression(left.argument, right)) ||
    (t.isUnaryExpression(right, { operator: "!" }) &&
      t.isExpression(right.argument) &&
      sameExpression(left, right.argument))
  )
}

interface Formula {
  evaluate(values: ReadonlyMap<string, boolean>): boolean
}

function buildFormula(path: NodePath<t.Expression>, atoms: Map<string, t.Identifier>): Formula | undefined {
  if (
    path.isParenthesizedExpression() ||
    path.isTSAsExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTypeCastExpression()
  ) {
    return buildFormula(expressionPath(path, "expression"), atoms)
  }
  if (path.isBooleanLiteral()) return { evaluate: () => path.node.value }
  if (path.isIdentifier()) {
    if (!isPureStableBoolean(path)) return undefined
    atoms.set(path.node.name, path.node)
    return { evaluate: (values) => values.get(path.node.name)! }
  }
  if (path.isUnaryExpression({ operator: "!" }) && t.isExpression(path.node.argument)) {
    const child = buildFormula(expressionPath(path, "argument"), atoms)
    return child === undefined ? undefined : { evaluate: (values) => !child.evaluate(values) }
  }
  if (path.isLogicalExpression() && (path.node.operator === "&&" || path.node.operator === "||")) {
    const left = buildFormula(expressionPath(path, "left"), atoms)
    const right = buildFormula(expressionPath(path, "right"), atoms)
    if (left === undefined || right === undefined) return undefined
    return path.node.operator === "&&"
      ? { evaluate: (values) => left.evaluate(values) && right.evaluate(values) }
      : { evaluate: (values) => left.evaluate(values) || right.evaluate(values) }
  }
  return undefined
}

function formulaReplacement(path: NodePath<t.Expression>, limit: number): t.Expression | undefined {
  const atoms = new Map<string, t.Identifier>()
  const formula = buildFormula(path, atoms)
  if (formula === undefined || atoms.size === 0 || atoms.size > limit) return undefined
  const names = [...atoms.keys()].sort()
  const outputs: boolean[] = []
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    const values = new Map<string, boolean>()
    names.forEach((name, index) => values.set(name, Boolean(mask & (1 << index))))
    outputs.push(formula.evaluate(values))
  }
  if (outputs.every(Boolean)) return t.booleanLiteral(true)
  if (outputs.every((value) => !value)) return t.booleanLiteral(false)
  for (let index = 0; index < names.length; index += 1) {
    const matches = outputs.every((value, mask) => value === Boolean(mask & (1 << index)))
    if (matches) return t.cloneNode(atoms.get(names[index]!)!)
    const matchesNegation = outputs.every((value, mask) => value !== Boolean(mask & (1 << index)))
    if (matchesNegation) return t.unaryExpression("!", t.cloneNode(atoms.get(names[index]!)!))
  }
  return undefined
}

function simplifyLogical(path: NodePath<t.LogicalExpression>, state: PassState): void {
  const left = expressionPath(path, "left")
  const right = expressionPath(path, "right")
  const leftConstant = constantOf(left.node)

  if (leftConstant !== "unknown") {
    if (path.node.operator === "&&" && leftConstant === false) {
      const replacement = evaluationThen(left, t.booleanLiteral(false), state, true)
      if (replacement !== undefined) replaceExpression(path, replacement, state)
      return
    }
    if (path.node.operator === "||" && leftConstant === true) {
      const replacement = evaluationThen(left, t.booleanLiteral(true), state, true)
      if (replacement !== undefined) replaceExpression(path, replacement, state)
      return
    }
    const selectsRight =
      (path.node.operator === "&&" && leftConstant === true) ||
      (path.node.operator === "||" && leftConstant === false)
    if (selectsRight) {
      const effects = conditionEffects(left, state)
      if (effects !== undefined) replaceExpression(path, sequenceWithResult(effects, right.node), state)
      return
    }
  }

  if (right.isBooleanLiteral()) {
    const absorbs =
      (path.node.operator === "&&" && right.node.value === false) ||
      (path.node.operator === "||" && right.node.value === true)
    if (absorbs) {
      if (isBoolean(left)) {
        if (isRemovablePure(left)) {
          replaceExpression(path, t.booleanLiteral(right.node.value), state)
        } else {
          const replacement = evaluationThen(left, t.booleanLiteral(right.node.value), state, false)
          if (replacement !== undefined) replaceExpression(path, replacement, state)
        }
      }
      return
    }

    const identity =
      (path.node.operator === "&&" && right.node.value === true) ||
      (path.node.operator === "||" && right.node.value === false)
    if (identity && isBoolean(left)) {
      replaceExpression(path, left.node, state)
      return
    }
  }

  if (sameExpression(left.node, right.node) && isPureStableBoolean(left) && isPureStableBoolean(right)) {
    replaceExpression(path, left.node, state)
    return
  }
  if (logicalComplement(left.node, right.node) && isPureStableBoolean(left) && isPureStableBoolean(right)) {
    replaceExpression(path, t.booleanLiteral(path.node.operator === "||"), state)
    return
  }

  const symbolic = formulaReplacement(path, state.options.solverVariableLimit)
  if (symbolic !== undefined && !sameExpression(path.node, symbolic)) replaceExpression(path, symbolic, state)
}

function commentsIn(node: t.Node | null | undefined): t.Comment[] {
  if (node == null) return []
  const comments: t.Comment[] = []
  const seen = new Set<string>()
  t.traverseFast(node, (child) => {
    for (const comment of [
      ...(child.leadingComments ?? []),
      ...(child.innerComments ?? []),
      ...(child.trailingComments ?? []),
    ]) {
      const key = `${comment.start ?? ""}:${comment.end ?? ""}:${comment.value}`
      if (!seen.has(key)) {
        seen.add(key)
        comments.push(comment)
      }
    }
  })
  return comments
}

function protectedComment(comment: t.Comment): boolean {
  return /\b(?:TODO|FIXME)\b|@license|copyright|^\s*[#@](?:preserve|__PURE__)/i.test(comment.value)
}

function processRemovedComments(node: t.Node | null | undefined, state: PassState): t.Comment[] {
  const retained: t.Comment[] = []
  for (const comment of commentsIn(node)) {
    const keep = state.options.commentPolicy === "preserve" || protectedComment(comment)
    if (keep) retained.push(comment)
    if (state.options.commentPolicy !== "discard" || keep) {
      const location = comment.loc?.start
      state.report.removedComments.push({
        value: comment.value.trim(),
        ...(location === undefined ? {} : { location: { line: location.line, column: location.column + 1 } }),
        retained: keep,
      })
    }
  }
  return retained
}

function hasDirectLexicalDeclarations(block: t.BlockStatement): boolean {
  return block.body.some(
    (statement) =>
      (t.isVariableDeclaration(statement) && statement.kind !== "var") ||
      t.isFunctionDeclaration(statement) ||
      t.isClassDeclaration(statement),
  )
}

function branchStatements(statement: t.Statement): t.Statement[] {
  if (!t.isBlockStatement(statement)) return [statement]
  if (hasDirectLexicalDeclarations(statement)) return [statement]
  const body = statement.body
  if (body.length > 0 && statement.leadingComments?.length) {
    body[0]!.leadingComments = [...statement.leadingComments, ...(body[0]!.leadingComments ?? [])]
  }
  return body
}

function attachLeadingComments(statements: t.Statement[], comments: t.Comment[]): t.Statement[] {
  if (comments.length === 0) return statements
  if (statements.length === 0) {
    const placeholder = t.emptyStatement()
    placeholder.leadingComments = comments
    return [placeholder]
  }
  statements[0]!.leadingComments = [...comments, ...(statements[0]!.leadingComments ?? [])]
  return statements
}

function replaceStatement(path: NodePath<t.Statement>, statements: t.Statement[], state: PassState): void {
  const replacements = statements.length === 0 && !path.inList ? [t.emptyStatement()] : statements
  if (replacements.length === 0) path.remove()
  else if (path.inList) path.replaceWithMultiple(replacements)
  else if (replacements.length === 1) path.replaceWith(replacements[0]!)
  else path.replaceWith(t.blockStatement(replacements))
  state.changes += 1
}

function simplifyIf(path: NodePath<t.IfStatement>, state: PassState): void {
  const test = expressionPath(path, "test")
  const constant = constantOf(test.node)
  if (constant === "unknown") return
  const effects = conditionEffects(test, state)
  if (effects === undefined) return
  const selected = constant ? path.node.consequent : path.node.alternate
  const removed = constant ? path.node.alternate : path.node.consequent
  const retainedComments = processRemovedComments(removed, state)
  const statements = [
    ...effects.map((effect) => t.expressionStatement(effect)),
    ...(selected == null ? [] : branchStatements(selected)),
  ]
  if (statements.length > 0) t.inheritsComments(statements[0]!, path.node)
  replaceStatement(path, attachLeadingComments(statements, retainedComments), state)
  state.report.deadBranchesRemoved += 1
}

function simplifyConditional(path: NodePath<t.ConditionalExpression>, state: PassState): void {
  const test = expressionPath(path, "test")
  const constant = constantOf(test.node)
  if (constant === "unknown") return
  const effects = conditionEffects(test, state)
  if (effects === undefined) return
  const selected = constant ? path.node.consequent : path.node.alternate
  const removed = constant ? path.node.alternate : path.node.consequent
  const retained = processRemovedComments(removed, state)
  if (retained.length > 0) selected.leadingComments = [...retained, ...(selected.leadingComments ?? [])]
  replaceExpression(path, sequenceWithResult(effects, selected), state)
  state.report.deadBranchesRemoved += 1
}

function simplifyWhile(path: NodePath<t.WhileStatement>, state: PassState): void {
  const test = expressionPath(path, "test")
  if (constantOf(test.node) !== false) return
  const effects = conditionEffects(test, state)
  if (effects === undefined) return
  const retained = processRemovedComments(path.node.body, state)
  const statements = attachLeadingComments(effects.map((effect) => t.expressionStatement(effect)), retained)
  replaceStatement(path, statements, state)
  state.report.deadBranchesRemoved += 1
}

function simplifyFor(path: NodePath<t.ForStatement>, state: PassState): void {
  if (path.node.test === null) return
  const test = expressionPath(path, "test")
  if (constantOf(test.node) !== false) return
  const effects = conditionEffects(test, state)
  if (effects === undefined) return
  const statements: t.Statement[] = []
  if (path.node.init !== null) {
    statements.push(
      t.isVariableDeclaration(path.node.init)
        ? path.node.init
        : t.expressionStatement(path.node.init as t.Expression),
    )
  }
  statements.push(...effects.map((effect) => t.expressionStatement(effect)))
  const retained = processRemovedComments(path.node.body, state)
  const output =
    t.isVariableDeclaration(path.node.init) && path.node.init.kind !== "var"
      ? [t.blockStatement(attachLeadingComments(statements, retained))]
      : attachLeadingComments(statements, retained)
  replaceStatement(path, output, state)
  state.report.deadBranchesRemoved += 1
}

function hasLoopControl(body: t.Statement): boolean {
  let found = false
  t.traverseFast(body, (node) => {
    if (t.isBreakStatement(node) || t.isContinueStatement(node)) found = true
  })
  return found
}

function simplifyDoWhile(path: NodePath<t.DoWhileStatement>, state: PassState): void {
  const test = expressionPath(path, "test")
  if (constantOf(test.node) !== false || hasLoopControl(path.node.body)) return
  const effects = conditionEffects(test, state)
  if (effects === undefined) return
  replaceStatement(
    path,
    [...branchStatements(path.node.body), ...effects.map((effect) => t.expressionStatement(effect))],
    state,
  )
  state.report.deadBranchesRemoved += 1
}

function terminates(statement: t.Statement): boolean {
  if (
    t.isReturnStatement(statement) ||
    t.isThrowStatement(statement) ||
    t.isBreakStatement(statement) ||
    t.isContinueStatement(statement)
  ) {
    return true
  }
  return t.isBlockStatement(statement) && statement.body.length > 0 && terminates(statement.body.at(-1)!)
}

function removableUnreachable(statement: t.Statement): boolean {
  return !(
    t.isDeclaration(statement) ||
    t.isImportDeclaration(statement) ||
    t.isExportDeclaration(statement) ||
    t.isLabeledStatement(statement)
  )
}

function removeUnreachable(path: NodePath<t.Program | t.BlockStatement>, state: PassState): void {
  const body = path.node.body
  let terminated = false
  for (let index = 0; index < body.length; index += 1) {
    const statement = body[index]!
    if (!terminated) {
      terminated = terminates(statement)
      continue
    }
    if (!removableUnreachable(statement)) continue
    const retained = processRemovedComments(statement, state)
    if (retained.length > 0 && index > 0) {
      body[index - 1]!.trailingComments = [...(body[index - 1]!.trailingComments ?? []), ...retained]
    }
    body.splice(index, 1)
    index -= 1
    state.changes += 1
    state.report.unreachableStatementsRemoved += 1
  }
}

function simplifyExpressionStatement(path: NodePath<t.ExpressionStatement>, state: PassState): void {
  const expression = expressionPath(path, "expression")
  if (constantOf(expression.node) === "unknown") return
  const effects = conditionEffects(expression, state)
  if (effects === undefined || (effects.length === 1 && effects[0] === expression.node)) return
  if (effects.length === 0) {
    if (path.node.leadingComments?.length || path.node.trailingComments?.length) return
    path.remove()
  } else {
    path.replaceWithMultiple(effects.map((effect) => t.expressionStatement(effect)))
  }
  state.changes += 1
  state.report.expressionsFolded += 1
}

function simplifyJsxContainer(path: NodePath<t.JSXExpressionContainer>, state: PassState): void {
  const expression = path.node.expression
  if (t.isJSXEmptyExpression(expression)) return
  if (path.parentPath.isJSXAttribute() && t.isBooleanLiteral(expression, { value: true })) {
    path.parentPath.node.value = null
    state.changes += 1
    return
  }
  if (!path.parentPath.isJSXElement() && !path.parentPath.isJSXFragment()) return
  if (t.isBooleanLiteral(expression, { value: false })) {
    path.remove()
    state.changes += 1
  } else if (t.isJSXElement(expression) || t.isJSXFragment(expression)) {
    path.replaceWith(expression)
    state.changes += 1
  }
}

export function simplifyPass(
  ast: t.File,
  options: SimplifyOptions,
  report: TransformReport,
): number {
  const state: PassState = { changes: 0, options, report }
  traverse(ast, {
    UnaryExpression: {
      exit(path) {
        if (path.node.operator !== "!" || !t.isExpression(path.node.argument)) return
        const argument = expressionPath(path, "argument")
        const constant = constantOf(argument.node)
        if (constant === "unknown") return
        const replacement = evaluationThen(argument, t.booleanLiteral(!constant), state, true)
        if (replacement !== undefined) replaceExpression(path, replacement, state)
      },
    },
    BinaryExpression: {
      exit(path) {
        const constant = constantOf(path.node)
        if (constant === "unknown") return
        const typedPath = path as NodePath<t.Expression>
        const effects = conditionEffects(typedPath, state)
        if (effects !== undefined) replaceExpression(typedPath, sequenceWithResult(effects, t.booleanLiteral(constant)), state)
      },
    },
    LogicalExpression: {
      exit(path) {
        simplifyLogical(path, state)
      },
    },
    ConditionalExpression: {
      exit(path) {
        simplifyConditional(path, state)
      },
    },
    IfStatement: {
      exit(path) {
        simplifyIf(path, state)
      },
    },
    WhileStatement: {
      exit(path) {
        simplifyWhile(path, state)
      },
    },
    ForStatement: {
      exit(path) {
        simplifyFor(path, state)
      },
    },
    DoWhileStatement: {
      exit(path) {
        simplifyDoWhile(path, state)
      },
    },
    ExpressionStatement: {
      exit(path) {
        simplifyExpressionStatement(path, state)
      },
    },
    JSXExpressionContainer: {
      exit(path) {
        simplifyJsxContainer(path, state)
      },
    },
    BlockStatement: {
      exit(path) {
        removeUnreachable(path, state)
      },
    },
    Program: {
      exit(path) {
        removeUnreachable(path, state)
      },
    },
  })
  return state.changes
}
