# 🧹 flag-prune

**Remove feature flags from JavaScript and TypeScript without turning cleanup into a manual refactor.**

`flag-prune` is a safe, deterministic codemod for JS, JSX, TS, and TSX. Give it the final value of a flag and it replaces matching reads, folds expressions to a fixed point, removes dead control flow, and cleans up bindings and imports while preserving required runtime evaluation.

```diff
- const enabled = useFlag("new-feature")
- if (enabled) {
-   showFeature()
- } else {
-   legacyFeature()
- }
+ showFeature()
```

```sh
npx flag-prune --set 'useFlag("new-feature")=true' ./
```

## Quick start

### Interactive mode

Run without arguments to answer three prompts, preview the result, and optionally write it:

```sh
npx flag-prune
```

### Explicit mode

Preview a migration. Dry-run mode is the default, so the first run prints a diff without changing files:

```sh
npx flag-prune --set 'useFlag("new-access")=false' ./src
```

Write the reviewed changes:

```sh
npx flag-prune --set 'useFlag("new-access")=false' --write ./src
```

Then run your project's typecheck, lint, and tests.

## But why?

**Feature-flag removal should be mechanical.**

A general-purpose coding AI agent can coordinate a migration, but the repetitive transformation is better handled by a deterministic tool. The same input and rules should produce the same output. This makes large cleanups faster, more predictable, and much less expensive than burning through LLM tokens or reviewer time.

`flag-prune` is provider-agnostic. It can match hooks, functions, client methods, imported constants, global members, and variant values without knowing which feature-flag SDK produced them. See the [feature flag provider guides](docs/guides/providers/README.md) for Unleash, LaunchDarkly, PostHog, Statsig, and OpenFeature examples.

Excellent projects of [Fallow](https://fallow.dev/), [Knip](https://knip.dev/), and countless predecessors do a great job of removing unused code, but are focused on dead files and imports rather than evaluation. Use them after a `flag-prune` pass.

### Acknowledgments

This project was inspired by:

- years of work on feature management platform [Unleash](https://www.getunleash.io/)
- a tool by Uber [PolyglotPiranha](https://github.com/uber/piranha/blob/master/POLYGLOT_README.md)

## Common rules

Repeat `--set` to remove related flags in one pass.

```sh
# Local or global member
npx flag-prune --set 'features.newCheckout=false' ./src

# Imported constant; aliases are resolved
npx flag-prune --set './flags#NEW_CHECKOUT=false' ./src

# Function or method call with an exact argument prefix
npx flag-prune --set 'useFlag("new-checkout")=false' ./src
npx flag-prune --set 'client.isEnabled("new-checkout")=false' ./src

# String, number, and null values
npx flag-prune --set 'getVariant("checkout")=treatment' ./src
npx flag-prune --set 'limits.maxSeats=25' ./src
npx flag-prune --set 'readOverride()=null' ./src

# Environment variables
npx flag-prune --set 'process.env.FEATURE_FLAG=true' ./src
```

Configured call arguments must be static string, number, boolean, or `null` literals. Additional arguments at the call site are allowed, and any required evaluation is preserved.

See [Flag rules](docs/flag-rules.md) for the complete syntax and matching model.

## What can it do?

- Boolean branches, ternaries, logical expressions, nullish coalescing, and selected loops.
- String and numeric comparisons such as `===`, `!==`, `<`, `<=`, `>`, and `>=`.
- Object and array variant values, folding static member and index reads while preserving object identity.
- Stable local bindings assigned from a configured flag read.
- JSX conditions and boolean attributes.
- Unreachable statements after `return`, `throw`, `break`, and `continue` where removal is safe.
- Imports and bindings made unused by the migration.

### Safety and limitations

- Unknown values and dynamic flag keys stay untouched. Calls with non-static arguments are not matched.
- Unused files, unused exports, or unused imports that are still referenced by other code are not removed. Use a linter or dead-code tool for that.
- The transform does not discard required `await`, `yield`, or other side effects. Calls, getters, computed keys, spreads, and other observable evaluation are preserved.
- Lexical scope and protects important comments are protected. Opt into de-scoping safe blocks with `--flatten-blocks`, which hoists declarations only when no name collision can occur.

See [Safety guarantees](docs/safety.md) for the detailed rules and opt-outs.

## CI

Use `--json` for structured output and `--strict` to turn warnings into exit code `2`.

See [CI and automation](docs/ci.md) for a GitHub Actions example and exit-code guidance.

## Documentation

AI tools and documentation crawlers can use
[`docs/llms.txt`](docs/llms.txt) for a quick start and documentation link.

| Page                                               | Use it for                                             |
| -------------------------------------------------- | ------------------------------------------------------ |
| [Provider guides](docs/guides/providers/README.md) | Remove flags from popular feature flag providers: [Unleash](docs/guides/providers/unleash.md), [LaunchDarkly](docs/guides/providers/launchdarkly.md), [PostHog](docs/guides/providers/posthog.md), [Statsig](docs/guides/providers/statsig.md), [OpenFeature](docs/guides/providers/openfeature.md).       |
| [Documentation overview](docs/README.md)           | Choose the right guide or reference page               |
| [Getting started](docs/getting-started.md)         | Run a first migration safely                           |
| [Recommended workflow](docs/workflow.md)           | Chain flag-prune with checks, dead-code tools, and an LLM cleanup pass |
| [Flag rules](docs/flag-rules.md)                   | Define exact member, import, and call matches          |
| [Recipes](docs/recipes.md)                         | Copy focused examples for common flag shapes           |
| [CLI reference](docs/cli.md)                       | Review options, file discovery, output, and exit codes |
| [CI and automation](docs/ci.md)                    | Add checks and machine-readable reporting              |
| [Library API](docs/library-api.md)                 | Call the transform from JavaScript or TypeScript       |
| [Safety guarantees](docs/safety.md)                | Understand preservation and conservative behavior      |
| [Troubleshooting](docs/troubleshooting.md)         | Diagnose unmatched rules, warnings, and parse failures |



## Requirements

- Node.js 22 or newer.
- Supported source files: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, and `.cts`.
- Type declaration files such as `.d.ts` are skipped.
