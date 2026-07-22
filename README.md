# flagrM

`flagrm` is a conservative JS/TS/JSX/TSX codemod for removing feature flags. Its `flag-clean` CLI replaces configured flag reads with known booleans, folds expressions to a fixed point, removes dead control flow, preserves required evaluation and side effects, cleans configured imports, reparses output, and reports every transformation.

## Install and use

```sh
pnpm add -D flagrm
```

Preview one flag without creating a config file:

```sh
flag-clean --flag hasFeature.newAccessControl=true src
```

Apply it after reviewing the diff:

```sh
flag-clean --flag hasFeature.newAccessControl=true --write src
```

Imported flags use `module#export.path=value`:

```sh
flag-clean --flag ./features#hasFeature.newAccessControl=true --write src
```

Repeat `--flag` for related flags. For approved calls, verification settings, or reusable migrations, create `flag-clean.config.json`:

```json
{
  "flags": [
    {
      "module": "./features",
      "export": "hasFeature",
      "path": ["newAccessControl"],
      "value": true
    },
    {
      "module": "./features",
      "call": "featureEnabled",
      "arguments": ["legacy-export"],
      "value": false
    }
  ],
  "preserveEffects": true,
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
flag-clean src
```

Write atomically and run project checks:

```sh
flag-clean --write --typecheck --lint --test src
```

Use `--check` in CI to fail when changes remain and `--json` for machine-readable reports.

## Library API

```ts
import { transform } from "flagrm"

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

Module-backed definitions match the exact import binding, including aliases, and never match shadowing declarations. Global/identifier definitions bind to the program-level declaration when one exists; otherwise they match only unresolved references. Static calls require exact primitive arguments. Optional access is matched only with `"optional": true`.

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

Set `preserveEffects` to `false` to skip transformations whose constant condition still requires runtime evaluation. The tool never discards those effects.
