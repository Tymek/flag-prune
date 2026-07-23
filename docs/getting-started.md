# Getting started

This guide removes one flag, previews the change, and writes it after review.

## Requirements

`flag-prune` requires Node.js 22 or newer and accepts these source extensions:

```text
.js .jsx .mjs .cjs .ts .tsx .mts .cts
```

Type declaration files such as `.d.ts`, `.d.mts`, and `.d.cts` are skipped.

## 1. Choose a flag and its final value

Suppose the codebase contains:

```ts
const enabled = useFlag("new-access")

if (enabled) {
  showNewAccess()
} else {
  showLegacyAccess()
}
```

The rollout is over and `new-access` is permanently disabled. The matching rule is:

```text
useFlag("new-access")=false
```

## 2. Preview the migration

Run `flag-prune` against a file or directory:

```sh
npx flag-prune --flag 'useFlag("new-access")=false' src
```

Dry-run mode is the default. The command prints a unified diff and a summary without changing files.

Expected result:

```ts
showLegacyAccess()
```

The tool replaces the call, propagates the fixed value through `enabled`, removes the dead branch, and removes the unused binding.

## 3. Review warnings

Warnings can identify skipped symlinks, files that could not be parsed, removed comments, or a transform that did not converge.

Review warnings before writing. Use `--strict` in automation when warnings should fail the run.

## 4. Write the change

After reviewing the preview, add `--write`:

```sh
npx flag-prune \
  --flag 'useFlag("new-access")=false' \
  --write \
  src
```

Writes are atomic and preserve the target file's mode. When a direct file target is a symlink, the linked file is updated without replacing the symlink itself.

## 5. Verify the repository

Run the project's normal checks:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Use the equivalent commands for your repository.

`flag-prune` reparses generated output by default, but it does not run your project's typechecker, linter, or tests.

## 6. Confirm idempotence

Run the same `flag-prune` command again. A completed migration should report no changed files.

## Guided mode

For an interactive first run:

```sh
npx flag-prune
```

Guided mode asks for:

1. The flag selector.
2. The replacement value.
3. The files or directories to scan.

It then previews the result and asks whether to write it. Guided mode does not run when `CI=true`.

## Remove multiple related flags

Repeat `--flag`:

```sh
npx flag-prune \
  --flag 'useFlag("new-access")=false' \
  --flag 'getVariant("access-layout")=legacy' \
  --flag 'limits.maxAccessGroups=5' \
  src
```

Applying related final values together lets the simplifier fold expressions that depend on more than one flag.

## Next steps

- Learn the complete selector syntax in [Flag rules](flag-rules.md).
- Copy provider-agnostic examples from [Recipes](recipes.md).
- Add a pull-request check with [CI and automation](ci.md).
