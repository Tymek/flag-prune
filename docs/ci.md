# CI and automation

`flag-prune` supports two common automation modes:

1. **Check mode** verifies that a configured cleanup has already been applied.
2. **JSON mode** lets scripts and coding agents inspect exact changes and warnings.

## Check mode

Use `--check` to return exit code `1` when files would change:

```sh
npx flag-prune \
  --set 'useFlag("new-access")=false' \
  --check \
  --no-diff \
  src
```

This is useful when:

- A migration branch should remain fully simplified.
- A final flag value is known but code may still be added behind the retired flag.
- An automated cleanup step is expected to leave the working tree unchanged.

`--check` does not write files.

## GitHub Actions

```yaml
name: Feature flag cleanup

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  flag-prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: >-
          npx flag-prune
          --set 'useFlag("new-access")=false'
          --check
          --strict
          --no-diff
          src
```

Pin the package version according to your dependency and supply all final flag rules required by the migration.

## Strict warnings

Add `--strict` when skipped files, symlinks, transform warnings, or other warnings should fail the job:

```sh
npx flag-prune \
  --set 'FLAG=false' \
  --check \
  --strict \
  --no-diff \
  src
```

Exit code `2` distinguishes warnings or processing failures from exit code `1`, which means valid source files would change.

## JSON output

Use `--json` for an aggregate report plus one report per processed file:

```sh
npx flag-prune \
  --set 'useFlag("new-access")=false' \
  --json \
  src > flag-prune-report.json
```

JSON mode disables unified diff output. It can be combined with `--check` and `--strict`:

```sh
npx flag-prune \
  --set 'useFlag("new-access")=false' \
  --json \
  --check \
  --strict \
  src
```

The report includes counts for replacements, folded expressions, removed branches, removed bindings and imports, preserved effects, comments, warnings, passes, and convergence.

## Automated write mode

A bot or migration script can run with `--write`:

```sh
npx flag-prune \
  --set 'useFlag("new-access")=false' \
  --write \
  src
```

After writing, run the repository's typecheck, lint, and test commands. `flag-prune` reparses generated output but does not run project-specific verification.

A typical automated migration sequence is:

```sh
npx flag-prune --set 'useFlag("new-access")=false' --write src
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

## Agent workflows

For a coding agent, prefer:

```sh
npx flag-prune \
  --set 'useFlag("new-access")=false' \
  --json \
  src
```

The agent can review the structured report, rerun with `--write`, execute repository checks, and confirm that a final dry run reports zero changed files.

This division keeps flag removal deterministic while leaving orchestration and review to the agent.
