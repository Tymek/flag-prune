# Library API

The package exports the source transform, configuration validation, and all public TypeScript types.

```ts
import {
  transform,
  validateConfig,
  type FlagDefinition,
  type TransformOptions,
  type TransformResult,
} from "flag-prune"
```

## `transform(source, options)`

```ts
function transform(source: string, options: TransformOptions): TransformResult
```

Example:

```ts
import { transform } from "flag-prune"

const source = `
const enabled = useFlag("new-access")
if (enabled) showNewAccess()
else showLegacyAccess()
`

const result = transform(source, {
  filename: "access.ts",
  flags: [
    {
      call: "useFlag",
      arguments: ["new-access"],
      value: false,
    },
  ],
})

console.log(result.code)
console.log(result.changed)
console.log(result.report)
```

Output code:

```ts
showLegacyAccess()
```

`filename` is optional but recommended. It improves parse errors and controls whether `.ts`-family files are parsed without JSX ambiguity.

## `FlagDefinition`

A definition selects either a value read or a call.

```ts
interface FlagDefinition {
  module?: string
  export?: string
  identifier?: string
  path?: string[]
  call?: string
  arguments?: Array<string | number | boolean | null>
  value?: FlagValue
}

type FlagValue =
  | string
  | number
  | boolean
  | null
  | FlagValue[]
  | { [key: string]: FlagValue }
```

A `value` may be a primitive or a nested array or object. Object and array
values model variant payloads: `flag-prune` folds static member and index reads
of the resolved value while preserving object identity for whole-value uses.

### Identifier or member

```ts
const flag: FlagDefinition = {
  identifier: "features",
  path: ["checkout", "newUi"],
  value: false,
}
```

This matches static reads of `features.checkout.newUi`, including equivalent optional access.

### Imported value

```ts
const flag: FlagDefinition = {
  module: "./flags",
  export: "NEW_CHECKOUT",
  value: false,
}
```

Import aliases and namespace imports are resolved. Local shadowing is not changed.

For a default import, set `export: "default"`.

### Call

```ts
const flag: FlagDefinition = {
  call: "client.isEnabled",
  arguments: ["new-checkout"],
  value: false,
}
```

`call` must be a static dotted function name. `arguments` are an exact required prefix. Additional caller arguments are allowed and their required evaluation is preserved.

### Imported call

```ts
const flag: FlagDefinition = {
  module: "flag-client",
  call: "useFlag",
  arguments: ["new-checkout"],
  value: false,
}
```

This resolves the exact imported binding, including aliases, instead of matching every unresolved `useFlag` call.

### Definition constraints

A definition must include one of:

- `call`
- `export`
- `identifier`

It cannot combine:

- `call` with `export` or `identifier`
- `module` with `identifier`

When `value` is omitted, it defaults to `true`.

## `TransformOptions`

```ts
interface TransformOptions {
  filename?: string
  flags: FlagDefinition[]
  simplifyEffectfulConditions?: boolean
  removeUnusedImports?: boolean
  removeSideEffectImports?: boolean
  flattenBlocks?: boolean
  commentPolicy?: "report" | "preserve" | "discard"
  maxPasses?: number
  solverVariableLimit?: number
  verify?: {
    parse?: boolean
  }
}
```

| Option                        | Default     | Description                                                                          |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `filename`                    | `undefined` | Used in parse errors and parser mode selection.                                      |
| `flags`                       | required    | Exact flag definitions to replace.                                                   |
| `simplifyEffectfulConditions` | `true`      | Collapse constant conditions while retaining required condition effects.             |
| `removeUnusedImports`         | `true`      | Remove import bindings made unused by the transform.                                 |
| `removeSideEffectImports`     | `false`     | Remove the final empty configured import instead of retaining module initialization. |
| `flattenBlocks`               | `false`     | De-scope blocks left by folding when hoisting their declarations is provably safe.   |
| `commentPolicy`               | `"report"`  | Handle comments in removed code.                                                     |
| `maxPasses`                   | `20`        | Maximum simplification passes before reporting non-convergence.                      |
| `solverVariableLimit`         | `8`         | Variable limit for bounded pure propositional simplification.                        |
| `verify.parse`                | `true`      | Reparse generated output before returning.                                           |

`removeSideEffectImports: true` should only be used for modules known not to perform initialization when imported.

## `TransformResult`

```ts
interface TransformResult {
  code: string
  changed: boolean
  report: TransformReport
}
```

`changed` is based on the final printed code. Untouched dynamic source is returned byte-for-byte.

## `TransformReport`

```ts
interface TransformReport {
  filename?: string
  flagsReplaced: number
  expressionsFolded: number
  deadBranchesRemoved: number
  unreachableStatementsRemoved: number
  importsRemoved: number
  bindingsRemoved: number
  blocksFlattened: number
  effectsPreserved: number
  removedComments: RemovedComment[]
  warnings: string[]
  passes: number
  converged: boolean
}
```

A removed comment record has this shape:

```ts
interface RemovedComment {
  value: string
  location?: {
    line: number
    column: number
  }
  retained: boolean
}
```

## `validateConfig(input)`

```ts
function validateConfig(input: unknown): FlagCleanConfig
```

Use `validateConfig` at a boundary where configuration comes from JSON, a plugin, or another untyped source:

```ts
import { transform, validateConfig } from "flag-prune"

const config = validateConfig(JSON.parse(rawConfig))
const result = transform(source, { ...config, filename: "input.ts" })
```

Validation rejects unknown keys, ambiguous definitions, dynamic argument values, invalid comment policies, non-positive limits, and invalid verification options.

## Error behavior

`transform` throws when:

- The input cannot be parsed.
- Configuration is invalid.
- Generated output fails parse verification.

A transform that reaches `maxPasses` returns a report with `converged: false` and a warning. The CLI converts that state into exit code `2`.
