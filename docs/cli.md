# CLI reference

## Usage

```text
flag-prune [options] <file-or-directory...>
```

At least one flag rule and one target are required outside guided mode.

```sh
npx flag-prune --set 'useFlag("new-ui")=false' src packages/app
```

## Options

| Option                                         | Description                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `-s, --set <rule>`                            | Add a flag rule. Repeatable. Also accepts `-s=RULE` and `--set=RULE`.               |
| `-w, --write`                                  | Write changed files atomically.                                                      |
| `--dry-run`                                    | Preview only. This is the default and conflicts with `--write`.                      |
| `--check`                                      | Exit `1` when any file would change.                                                 |
| `--strict`                                     | Exit `2` when any warning is emitted.                                                |
| `--diff`                                       | Print unified diffs. Default in dry-run mode.                                        |
| `--no-diff`                                    | Hide unified diffs. Default with `--write` or `--json`.                              |
| `--json`                                       | Print a machine-readable aggregate and per-file report. Disables diff output.        |
| `--ignore <name>`                              | Skip an additional directory name. Repeatable.                                       |
| `--comment-policy <report\|preserve\|discard>` | Choose how comments in removed code are handled. Default: `report`.                  |
| `--keep-comments`                              | Shortcut for `--comment-policy preserve`.                                            |
| `--no-remove-unused-imports`                   | Keep imports after configured bindings become unused.                                |
| `--remove-side-effect-imports`                 | Remove an empty configured import instead of preserving module initialization.       |
| `--skip-effectful-conditions`                  | Leave constant conditions unchanged when evaluating the condition still has effects. |
| `--max-passes <n>`                             | Set the simplification pass limit. Default: `20`.                                    |
| `--no-parse-check`                             | Skip reparsing generated output.                                                     |
| `-h, --help`                                   | Print help.                                                                          |
| `-v, --version`                                | Print the version.                                                                   |

Use `--` to stop option parsing before file targets:

```sh
npx flag-prune --set 'FLAG=false' -- --generated.ts
```

## Guided mode

Running with no arguments starts a guided setup:

```sh
npx flag-prune
```

The prompts collect one selector, its value, and one or more comma-separated paths. The command previews the transform and asks whether to write it.

Guided mode is disabled when `CI=true`; a bare command in CI exits with code `2`.

## Flag input

The CLI accepts rules directly. It does not load `flag-prune.config.json` or a `--config` option.

```sh
npx flag-prune \
  --set 'features.newUi=false' \
  --set 'useFlag("new-navigation")=true' \
  src
```

See [Flag rules](flag-rules.md) for selector grammar and value parsing.

## File discovery

Directories are traversed recursively in stable sorted order.

Supported source extensions:

```text
.js .jsx .mjs .cjs .ts .tsx .mts .cts
```

Skipped by default:

- `.git`
- `node_modules`
- `dist`
- `coverage`
- Type declaration files such as `.d.ts`
- Nested symbolic links

Add directory names with `--ignore`:

```sh
npx flag-prune \
  --set 'FLAG=false' \
  --ignore generated \
  --ignore vendor \
  .
```

A direct file target that is itself a symlink can be transformed. Atomic writing updates its resolved target and preserves the symlink.

If no supported files are found, the command prints `flag-prune: no files found` and exits `0`.

## Dry-run and write behavior

### Dry-run

Dry-run is the default:

```sh
npx flag-prune --set 'FLAG=false' src
```

Changed files are not written. Unified diffs and a human summary are printed unless disabled.

### Write

```sh
npx flag-prune --set 'FLAG=false' --write src
```

Changed files are written atomically. Diff output is hidden by default, but can be enabled explicitly with `--diff`.

`--write` and `--dry-run` cannot be combined.

## Output formats

### Human summary

The default summary reports:

- Files changed.
- Flags replaced.
- Expressions folded.
- Dead branches removed.
- Unreachable statements removed.
- Imports and bindings removed.
- Effectful expressions preserved.
- Comments removed and reported.
- Warnings.

### Unified diff

Use `--diff` or rely on the dry-run default.

### JSON

```sh
npx flag-prune --set 'FLAG=false' --json src
```

The output shape is:

```ts
{
  report: {
    filesChanged: number
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
  files: Array<{
    path: string
    changed: boolean
    report: TransformReport
  }>
}
```

## Exit codes

| Code | Meaning                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| `0`  | Success. This includes a preview with changes, a successful write, no matching changes, or no supported files. |
| `1`  | `--check` was requested and one or more files would change.                                                    |
| `2`  | Usage or processing error, warnings under `--strict`, or failure to reach a fixed point.                       |

`--check` does not imply `--strict`. A warning only changes the exit code when `--strict` is also present.

## Comment handling

The default `report` policy removes ordinary dead comments and includes them in the report. Protected comments are retained.

```sh
npx flag-prune \
  --set 'FLAG=false' \
  --comment-policy preserve \
  src
```

Policies:

| Policy     | Behavior                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------- |
| `report`   | Remove ordinary dead comments and report them; retain protected comments.                |
| `preserve` | Move comments from removed code onto surviving output and report them as retained.       |
| `discard`  | Discard ordinary dead comments without reporting them; protected comments still survive. |

See [Safety guarantees](safety.md#comments) for protected comment categories.
