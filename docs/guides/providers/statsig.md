# Remove Statsig feature flags

Remove stale Statsig feature gates from JavaScript and TypeScript code with
`flag-prune`. See the official [Statsig JavaScript SDK
documentation](https://docs.statsig.com/client/javascript-sdk).

## Replace `checkGate`

```ts
if (client.checkGate("enable-new-search")) {
  showNewSearch()
} else {
  showOldSearch()
}
```

Preview a gate that is permanently enabled:

```sh
npx flag-prune --set 'client.checkGate("enable-new-search")=true' src
```

Result:

```ts
showNewSearch()
```

After reviewing the diff:

```sh
npx flag-prune --set 'client.checkGate("enable-new-search")=true' --write src
```

The receiver is an exact part of the rule. If the client variable is named
`statsig`, use `statsig.checkGate("enable-new-search")` instead.

Dynamic config and experiment APIs return structured results. Do not replace
the whole object with a primitive; use a primitive gate or refactor first.

See [all provider guides](README.md) and the detailed [call matching
rules](../../flag-rules.md#calls).
