# flag-prune

`flag-prune` is a conservative JS/TS/JSX/TSX codemod for removing feature flags. Its `flag-prune` CLI replaces configured flag reads with known booleans, folds expressions to a fixed point, removes dead control flow, preserves required evaluation and side effects, cleans configured imports, reparses output, and reports every transformation.

## Run without installing

```sh
npx flag-prune --flag hasFeature.newAccessControl src
```

Omitting `=true` or `=false` defaults to `true`. This previews the diff. Apply it after review:

```sh
npx flag-prune --flag hasFeature.newAccessControl=true --write src
```

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
