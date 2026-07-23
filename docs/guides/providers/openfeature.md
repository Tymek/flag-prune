# Remove OpenFeature feature flags

Remove stale OpenFeature feature flags from web and React code with
`flag-prune`. See the official [OpenFeature Web SDK
documentation](https://openfeature.dev/docs/reference/sdks/client/web/) and
[OpenFeature React SDK
documentation](https://openfeature.dev/docs/reference/sdks/client/web/react/).

## Web typed flag values

```ts
if (client.getBooleanValue("new-search", false)) {
  showNewSearch()
} else {
  showOldSearch()
}
```

Preview, then write after reviewing the diff:

```sh
npx flag-prune --set 'client.getBooleanValue("new-search")=true' src
npx flag-prune --set 'client.getBooleanValue("new-search")=true' --write src
```

The default value follows the stable flag-key prefix, so it does not need to be
in the rule. String values work in the same way:

```sh
npx flag-prune --set 'client.getStringValue("ui-theme")=dark' src
```

## React typed value hooks

```tsx
const enabled = useBooleanFlagValue("new-checkout", false)
return enabled ? <NewCheckout /> : <OldCheckout />
```

Preview the final value:

```sh
npx flag-prune --set 'useBooleanFlagValue("new-checkout")=false' src
```

OpenFeature's `useFlag()` returns a structured object. Do not replace the whole
result with a primitive; prefer a typed primitive hook such as
`useBooleanFlagValue()` for this workflow.

See [all provider guides](README.md) and the detailed [call matching
rules](../../flag-rules.md#calls).
