# flag-prune documentation

`flag-prune` replaces known feature-flag values and removes the code that can no longer run. Start with a preview, inspect the diff, then write the result.

## Start here

| Goal                                                                 | Page                                  |
| -------------------------------------------------------------------- | ------------------------------------- |
| Remove one flag for the first time                                   | [Getting started](getting-started.md) |
| Express a hook, client method, imported constant, variant, or member | [Flag rules](flag-rules.md)           |
| Copy a complete command for a common migration                       | [Recipes](recipes.md)                 |
| Review every command-line option                                     | [CLI reference](cli.md)               |
| Run in a pull request or CI pipeline                                 | [CI and automation](ci.md)            |
| Integrate the transform in another tool                              | [Library API](library-api.md)         |
| Understand what the codemod will and will not remove                 | [Safety guarantees](safety.md)        |
| Diagnose a rule that did not match                                   | [Troubleshooting](troubleshooting.md) |

## Mental model

Every run has three stages:

1. **Match** exact configured flag reads. Matching is binding-aware and does not replace shadowed locals.
2. **Replace** each matched read with its configured primitive value while preserving required evaluation.
3. **Simplify** expressions and control flow repeatedly until the output reaches a fixed point.

For example:

```ts
const variant = getVariant("checkout")

if (variant === "treatment") {
  showNewCheckout()
} else {
  showCurrentCheckout()
}
```

With this rule:

```sh
--flag 'getVariant("checkout")=treatment'
```

The result is:

```ts
showNewCheckout()
```

The now-unused `variant` binding and dead branch are removed as part of the same transform.

## Recommended workflow

1. Run in dry-run mode, which is the default.
2. Review the unified diff and warnings.
3. Rerun with `--write`.
4. Run your typecheck, lint, and tests.
5. Rerun the same command. A completed migration should be a no-op.

## Reference map

### Guides

- [Getting started](getting-started.md)
- [Recipes](recipes.md)
- [CI and automation](ci.md)
- [Troubleshooting](troubleshooting.md)

### Reference

- [Flag rules](flag-rules.md)
- [CLI reference](cli.md)
- [Library API](library-api.md)
- [Safety guarantees](safety.md)
