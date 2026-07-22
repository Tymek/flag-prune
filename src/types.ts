export type ConstantBoolean = boolean | "unknown"

export type Purity = "pure" | "effectful" | "unknown"

export interface Analysis {
  constant: ConstantBoolean
  purity: Purity
}

export type FlagArgument = string | number | boolean | null

export type FlagValue = string | number | boolean | null

export interface FlagDefinition {
  /** Exact module specifier from an import declaration. */
  module?: string
  /** Imported export containing the flag value or member root. */
  export?: string
  /** Program-level or global identifier containing the flag value or member root. */
  identifier?: string
  /** Static properties below export/identifier. */
  path?: string[]
  /** Approved static function name. Arguments are an exact required prefix. */
  call?: string
  arguments?: FlagArgument[]
  /** Required for matching optional member access or optional calls. */
  optional?: boolean
  /** Replacement value. Defaults to true. */
  value?: FlagValue
}

export type CommentPolicy = "report" | "preserve" | "discard"

export interface VerificationConfig {
  parse?: boolean
  typecheck?: boolean | string
  lint?: boolean | string
  tests?: boolean | string
}

export interface FlagCleanConfig {
  flags: FlagDefinition[]
  /** Simplify constant conditions whose evaluation still carries side effects. */
  simplifyEffectfulConditions?: boolean
  removeUnusedImports?: boolean
  /** Remove an import declaration after its last configured binding is removed. */
  removeSideEffectImports?: boolean
  commentPolicy?: CommentPolicy
  maxPasses?: number
  solverVariableLimit?: number
  verify?: VerificationConfig
}

export interface TransformOptions extends FlagCleanConfig {
  filename?: string
}

export interface SourceLocation {
  line: number
  column: number
}

export interface RemovedComment {
  value: string
  location?: SourceLocation
  retained: boolean
}

export interface TransformReport {
  filename?: string
  flagsReplaced: number
  expressionsFolded: number
  deadBranchesRemoved: number
  unreachableStatementsRemoved: number
  importsRemoved: number
  bindingsRemoved: number
  effectsPreserved: number
  removedComments: RemovedComment[]
  warnings: string[]
  passes: number
  converged: boolean
}

export interface TransformResult {
  code: string
  changed: boolean
  report: TransformReport
}
