# Safety guarantees

The central invariant is:

> Replace configured flag reads without changing the observable evaluation that must still occur.

`flag-prune` is deliberately conservative. A source shape that cannot be matched or simplified safely remains in place. Don't let AI guess.

## Exact, binding-aware matching

The tool matches syntax and bindings rather than searching text. It operates on the AST, not the raw source. This ensures that:

- Imported aliases resolve to the configured export.
- Namespace import members are supported.
- Local shadowing is not changed.
- Dynamic keys and dynamic configured arguments do not match.
- A stable call result can be propagated through a local binding.
- A reassigned binding is not treated as a fixed constant.

## Required evaluation is preserved

Removing a flag read must not accidentally remove observable work. The transform retains required evaluation from:

- Function and method calls.
- Getter or proxy-sensitive member reads.
- Assignments and mutations.
- `await` and `yield`.
- Computed object keys.
- Spread arguments and spread properties.
- Other expressions classified as effectful or unknown.

Example:

```ts
if (client.isEnabled("new-ui", loadContext())) {
  renderNewUi()
}
```

With a final value of `true`, the result is equivalent to:

```ts
loadContext()
renderNewUi()
```

The flag result disappears; the trailing argument's required evaluation does not.

## Short-circuiting remains short-circuited

The simplifier does not introduce calls that were previously unreachable.

```ts
true || load()
```

becomes:

```ts
true
```

`load()` remains unexecuted.

When an always-true condition must evaluate an effectful left side, that effect is retained:

```ts
if (load() || true) run()
```

becomes the equivalent of:

```ts
load()
run()
```

Set `simplifyEffectfulConditions: false` or use `--skip-effectful-conditions` to leave such conditions unchanged instead.

## Unknown values remain unknown

An expression is not simplified merely because a boolean identity would be valid for booleans.

```ts
const value = load() || true
```

stays unchanged in value context because `load()` might return a non-boolean value whose original result matters.

Boolean identities are applied only when the expression is known to be boolean, such as a literal, a boolean annotation, or a stable boolean initializer.

## Object identity is preserved

When a flag resolves to an object or array value, `flag-prune` folds static
member and index reads to their configured values but does not inline the whole
value at each reference. Reusing the same binding keeps object identity intact:

```ts
const variant = getVariant("checkout")
register(variant)
if (variant.enabled) enable()
```

With `getVariant("checkout")={ enabled: true }`, `variant.enabled` folds to
`true`, but the declaration is kept so `register(variant)` still receives one
object:

```ts
const variant = { enabled: true }
register(variant)
enable()
```

The declaration is removed only when every read is folded and nothing else uses
the binding. Member reads on an inline literal are folded only when the literal
is pure, so no observable evaluation is discarded.

## Empty object spreads are removed

Folding a flag inside an object spread can leave a spread that contributes no
properties, such as `...(false)` or `...({})`:

```ts
const where = {
  deactivatedAt: null,
  ...(hasFeature.newAccessControl ? {} : { permission: "COMPLIANCE_OFFICER" }),
}
```

With `hasFeature.newAccessControl` true, the spread folds to `...({})` and is
removed:

```ts
const where = {
  deactivatedAt: null,
}
```

Only object spreads are simplified, and only when the argument is pure and
provably contributes nothing: a boolean, number, bigint, or `null`, or an empty
object or array literal. String spreads, array spreads, non-empty objects, and
any spread whose argument has side effects are left unchanged.

## Lexical scope is de-scoped only when safe

Removing an `if` or loop can leave a bare block that exists only to scope `let`,
`const`, function, or class declarations. By default `flag-prune` de-scopes such
a block by hoisting its declarations into the parent block, but only when it is
provably safe:

- None of the block's directly declared names already bind in the parent scope
  or in a sibling statement, so hoisting cannot redeclare or shadow a binding.
- None of those names are referenced anywhere outside the block, so hoisting
  cannot capture an outer reference.
- The block contains no `using` or `await using` declaration, whose disposal is
  tied to the block's scope.

When any check fails, the block is left intact, and generated output is reparsed
to guarantee it stays valid.

```ts
if (FLAG) {
  const access = await load()
  user = await resolve(access)
}
```

With `FLAG` true, this de-scopes to:

```ts
const access = await load()
user = await resolve(access)
```

Set `flattenBlocks: false` or pass `--no-flatten-blocks` to keep the scoping
block instead:

```ts
{
  const access = await load()
  user = await resolve(access)
}
```

## Control flow is conservative

The transform can simplify:

- `if` statements.
- Conditional expressions.
- Selected `while`, `for`, and `do...while` loops.
- Unreachable statements after terminating control flow.

It avoids loop rewrites that would change `break` or `continue` behavior, and it preserves initializer and condition evaluation order.

## Imports preserve module initialization

When the final configured import binding is removed, the default result is a side-effect import:

```ts
import { FLAG } from "./flags"
```

becomes:

```ts
import "./flags"
```

This preserves module initialization.

Only set `removeSideEffectImports: true` or pass `--remove-side-effect-imports` when the module is proven side-effect-free.

## Comments

The default `report` policy records ordinary comments that belong only to removed code.

Protected comments survive regardless of the ordinary comment policy. Protection includes common markers such as:

- `TODO` and `FIXME`.
- `@license`, `@preserve`, and `@author`.
- `SPDX-License-Identifier`.
- Copyright notices with a year, `©`, or `(c)` marker.
- `#preserve`, `@preserve`, and `#__PURE__`-style directives.

Policies:

| Policy     | Behavior                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| `report`   | Remove and report ordinary dead comments; retain protected comments.      |
| `preserve` | Move comments onto surviving output and mark them retained in the report. |
| `discard`  | Do not report ordinary dead comments; protected comments still survive.   |

## Fixed-point simplification

Flag replacement often exposes another simplification:

```ts
A && (B || false);
```

With `A=true` and `B=false`, several passes may be required before the final expression is known. `flag-prune` repeats simplification until the code reaches a fixed point.

Defaults:

- Maximum passes: `20`.
- Bounded symbolic boolean variable limit: `8`.

If the pass limit is reached, the report sets `converged: false` and includes a warning. The CLI treats non-convergence as an error.

## Output verification and idempotence

Generated output is reparsed by default. Disable this only with `verify.parse: false` or `--no-parse-check`.

The test model expects representative transforms to be idempotent: applying the same rules to the transformed output should produce no additional change.

Reparsing is not a substitute for project checks. Run the repository's typecheck, lint, and tests after writing.

## Conservative opt-outs

| Need                                         | Library option                       | CLI option                    |
| -------------------------------------------- | ------------------------------------ | ----------------------------- |
| Keep effectful constant conditions unchanged | `simplifyEffectfulConditions: false` | `--skip-effectful-conditions` |
| Keep newly unused imports                    | `removeUnusedImports: false`         | `--no-remove-unused-imports`  |
| Preserve all removed comments                | `commentPolicy: "preserve"`          | `--keep-comments`             |
| Keep scoping blocks left by folding          | `flattenBlocks: false`               | `--no-flatten-blocks`         |
| Skip output reparsing                        | `verify: { parse: false }`           | `--no-parse-check`            |

Opt-in behavior that trades conservatism for a cleaner result:

| Need                                    | Library option          | CLI option          |
| --------------------------------------- | ----------------------- | ------------------- |
| Remove empty side-effect-free imports   | `removeSideEffectImports: true` | `--remove-side-effect-imports` |

The default settings favor useful cleanup while preserving evaluation and module behavior.
