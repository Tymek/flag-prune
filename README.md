# flag-prune

`flag-prune` is a conservative JS/TS/JSX/TSX codemod for removing feature flags. It replaces configured flag reads with their known values, folds expressions to a fixed point, removes dead control flow, preserves required evaluation and side effects, cleans configured imports, reparses the output, and reports every transformation.

## Run without installing

```sh
npx flag-prune --flag hasFeature.newAccessControl src
```

This previews the diff without touching files. Apply it after review:

```sh
npx flag-prune --flag hasFeature.newAccessControl=true --write src
```

> **A rule with no `=value` defaults to `true`.** `--flag hasFeature.x` is the
> same as `--flag hasFeature.x=true` and removes the *disabled* branch. Always
> pass `=false` explicitly when you are turning a flag off.

Equivalent one-off runners:

```sh
pnpm dlx flag-prune --flag hasFeature.newAccessControl=true src
yarn dlx flag-prune --flag hasFeature.newAccessControl=true src
bunx flag-prune --flag hasFeature.newAccessControl=true src
```

Imported flags use `module#export.path=value`:

```sh
npx flag-prune --flag ./features#hasFeature.newAccessControl=true --write src
```

This leaves a bare `import "./features"` to preserve module initialization. Add `--remove-side-effect-imports` only when that module is proven side-effect-free.

## Function and method calls

Calls use their exact source shape. Quote the rule so the shell does not interpret parentheses:

```sh
npx flag-prune --flag 'useFlag("new-access")=false' src
npx flag-prune --flag 'client.isEnabled("new-access")' --write src
```

Matching is provider-agnostic: any static dotted function name works. Configured arguments are an exact required prefix and must be string, number, boolean, or `null` literals. Additional caller arguments are allowed, so `client.isEnabled("new-access", context)` matches the second rule. Their evaluation and side effects are preserved. Dynamic keys stay untouched.

## Non-boolean values

Flags are not limited to booleans. A rule value may be a string, number, or `null`, which lets variant and tier flags resolve through comparisons:

```sh
npx flag-prune --flag 'getVariant("checkout")=treatment' src
npx flag-prune --flag 'limits.maxSeats=25' src
```

Given `getVariant("checkout") = "treatment"`, an expression like `variant === "treatment"` folds to `true` and its branch is selected. Numeric and string comparisons (`===`, `!==`, `<`, `<=`, `>`, `>=`) and `??` around resolved values fold too, so `config.featureToggles.newList ?? false` collapses.

Assigned results are propagated safely. For example:

```ts
const enabled = useFlag("new-access")
if (enabled) {
  showNewAccess()
} else {
  showLegacyAccess()
}
```

With `'useFlag("new-access")=false'`, this becomes `showLegacyAccess();`; the now-unused `enabled` binding is removed. Imported functions are matched through aliases and local shadowing is not changed.

Repeat `--flag` for related flags. For reusable migrations or verification settings, create `flag-prune.config.json`:

```json
{
  "flags": [
    {
      "module": "./features",
      "export": "hasFeature",
      "path": ["newAccessControl"]
    },
    {
      "module": "./features",
      "call": "featureClient.isEnabled",
      "arguments": ["legacy-export"],
      "value": false
    }
  ],
  "simplifyEffectfulConditions": true,
  "removeUnusedImports": true,
  "commentPolicy": "report",
  "verify": {
    "parse": true,
    "typecheck": false,
    "lint": false,
    "tests": false
  }
}
```

With the default config filename, the CLI finds it automatically:

```sh
npx flag-prune src
```

Write atomically and run project checks:

```sh
npx flag-prune --write --typecheck --lint --test src
```

Verification commands run after the files are written; if any check fails the
writes are rolled back. Verification also works on a dry run (without `--write`)
by applying the change transiently and restoring the source afterward.

> **Security:** `verify.typecheck`, `verify.lint`, and `verify.tests` are run
> through a shell. A checked-in `flag-prune.config.json` therefore executes
> arbitrary commands — review it like any other build script before running.

## CLI reference

Common options (`--help` lists them all):

| Option | Effect |
| --- | --- |
| `-f, --flag <rule>` | Flag rule; repeatable; also `-f=RULE` |
| `-c, --config <path>` | JSON config; auto-detected and merged with `--flag` |
| `-w, --write` / `--dry-run` | Write atomically / preview only (default) |
| `--check` | Exit 1 when files would change |
| `--strict` | Exit 2 when any warning is emitted |
| `--json` / `--diff` / `--no-diff` | Report format |
| `--ignore <name>` | Extra directory name to skip; repeatable |
| `--comment-policy <report\|preserve\|discard>` | Handling of comments on removed code |
| `--no-remove-unused-imports` | Keep imports after their flag binding is removed |
| `--skip-effectful-conditions` | Leave constant conditions whose test has effects |

Exit codes: `0` success, `1` `--check` found changes, `2` usage/processing
error (also `--strict` warnings or non-convergence). `.d.ts` files are skipped,
and nested symlinks are skipped with a warning.

Use `--check` in CI to fail when changes remain and `--json` for machine-readable reports.

## Library API

```ts
import { transform } from "flag-prune"

const result = transform(source, {
  filename: "access.ts",
  flags: [
    {
      identifier: "hasFeature",
      path: ["newAccessControl"],
      value: true,
    },
  ],
})

console.log(result.code)
console.log(result.report)
```

Module-backed definitions match the exact import binding, including aliases, and never match shadowing declarations. Global/identifier definitions bind to the program-level declaration when one exists; otherwise they match only unresolved references. Static calls support dotted callees and exact primitive argument prefixes. Replacement values default to `true` and may also be a string, number, or `null`. Optional access (`a?.b`, `call?.("k")`) is matched by the same rule as the plain form.

## Safety rules

- Unknown values are retained in value context. `const value = load() || true` stays unchanged.
- Constant boolean conditions still collapse safely. `if (load() || true) run()` becomes `load(); run()`.
- Short-circuited calls remain unexecuted. `true || load()` becomes `true`.
- Boolean identities requiring a boolean type apply only to literals, boolean annotations, or stable boolean initializers.
- Getter, proxy, assignment, `await`, `yield`, and call effects are not discarded.
- Blocks with lexical declarations keep their braces.
- Dead ordinary comments are reported. TODO, FIXME, license, copyright, and preserve directives survive.
- Removing the final configured import binding leaves `import "module"` to preserve module initialization. Set `removeSideEffectImports` only for a proven side-effect-free module.
- Output is reparsed and every fixture is expected to be idempotent.

Set `simplifyEffectfulConditions` to `false` (CLI: `--skip-effectful-conditions`) to leave constant conditions whose test still requires runtime evaluation. The tool never discards those effects.
