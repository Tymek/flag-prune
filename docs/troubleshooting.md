# Troubleshooting

## My rule did not match

Check the rule against the exact source shape.

### The key or argument is different

Call arguments are exact:

```sh
--set 'useFlag("new-ui")=false'
```

matches `useFlag("new-ui")` but not `useFlag("new_ui")`, `useFlag("other")`, or `useFlag(flagName)`.

### The access is dynamic

Static access can match:

```ts
features.newUi
features["newUi"]
features?.newUi
```

Dynamic access is intentionally ignored:

```ts
features[key]
```

### The binding is shadowed

A configured program-level or imported binding does not match a local parameter or variable with the same name.

```ts
import { FLAG } from "./flags"

function render(FLAG: boolean) {
  // This local FLAG is not replaced by ./flags#FLAG=false.
}
```

### The local result is reassigned

A call result is propagated only through a stable binding.

```ts
let enabled = useFlag("new-ui")
enabled = readOverride()
```

Because `enabled` is reassigned, it is not safe to replace all later reads with one constant.

### The module specifier is not exact

These are different selectors:

```text
./flags#FLAG
../flags#FLAG
@acme/flags#FLAG
```

Use the exact string from the source import declaration.

## The shell rejects my command

Quote rules containing parentheses, spaces, `#`, or shell-sensitive punctuation:

```sh
npx flag-prune --set 'useFlag("new-ui")=false' src
```

For a string value with spaces:

```sh
npx flag-prune --set 'getVariant("checkout")="new treatment"' src
```

## I received "arguments must be static JSON primitives"

Configured call arguments must be literal strings, numbers, booleans, negative numbers, or `null`.

Valid:

```sh
--set 'resolveFlag("checkout", 2, true, null)=false'
```

Invalid:

```sh
--set 'resolveFlag(flagName)=false'
```

The call site may still contain additional dynamic arguments after the configured prefix.

## I received "no flags provided"

The CLI accepts direct `--set` rules and does not load a config file:

```sh
npx flag-prune --set 'FLAG=false' src
```

There is no `--config` option.

## I received "provide at least one file or directory"

Add one or more targets:

```sh
npx flag-prune --set 'FLAG=false' src packages/app
```

## I received "no files found"

The target contained no supported source files, or only declaration files.

Supported extensions:

```text
.js .jsx .mjs .cjs .ts .tsx .mts .cts
```

Files such as `.d.ts` and Markdown are skipped. An empty target set is a successful no-op with exit code `0`.

## A directory was skipped

The following directory names are skipped by default:

```text
.git node_modules dist coverage
```

Any name passed with `--ignore` is also skipped.

Nested symlinks are skipped with a warning to avoid ambiguous or repeated traversal. Pass a symlink as a direct file target when you intentionally want to transform its resolved target.

## A file was skipped with a parse warning

The CLI processes files independently. If one file cannot be parsed, it reports a warning, skips that file, and continues with the rest.

Run with `--strict` when any skipped file should fail the command:

```sh
npx flag-prune --set 'FLAG=false' --strict src
```

Check that the file extension reflects its syntax. In particular, `.ts`, `.mts`, and `.cts` are parsed without JSX, while JSX-capable extensions enable JSX parsing.

## Semicolons or quotes changed on some lines

`flag-prune` preserves the original formatting of untouched code, but a statement
it moves or rewrites is reprinted in a normalized style. A moved expression
statement gains a trailing semicolon, for example, even if the source relied on
automatic semicolon insertion. This keeps the output valid and is expected.

Run your formatter (Prettier, Biome, or ESLint with the `semi` and `quotes`
rules) as part of the [recommended workflow](workflow.md); it normalizes
semicolon and quote style across the file so the final diff stays consistent.

## Comments disappeared

Ordinary comments located only in removed code are removed and reported by default.

Preserve them:

```sh
npx flag-prune \
  --set 'FLAG=false' \
  --comment-policy preserve \
  src
```

Protected license, preserve, TODO, FIXME, and copyright comments survive under every policy. See [Safety guarantees](safety.md#comments).

## An empty side-effect import remains

This is expected:

```ts
import "./flags"
```

It preserves module initialization after the final configured binding is removed.

Remove it only when the module is proven side-effect-free:

```sh
npx flag-prune \
  --set './flags#FLAG=false' \
  --remove-side-effect-imports \
  src
```

## An effectful condition was rewritten

By default, constant conditions are collapsed while required evaluation is kept:

```ts
if (load() || true) run()
```

becomes the equivalent of:

```ts
load()
run()
```

Keep the original condition instead:

```sh
npx flag-prune \
  --set 'FLAG=false' \
  --skip-effectful-conditions \
  src
```

## The command returned exit code 1

Exit code `1` is used only when `--check` is present and files would change. Preview or write the migration, then rerun the check.

## The command returned exit code 2

Exit code `2` indicates one of:

- Invalid arguments or rule syntax.
- A processing error.
- Warnings under `--strict`.
- Failure to reach a fixed point.

Read stderr for the specific error.

## The transform did not reach a fixed point

The default pass limit is `20`. Increase it temporarily:

```sh
npx flag-prune \
  --set 'FLAG=false' \
  --max-passes 40 \
  src
```

A representative migration should converge and become idempotent. If a small reproducible input repeatedly fails to converge, treat it as a bug rather than permanently relying on a very high limit.
