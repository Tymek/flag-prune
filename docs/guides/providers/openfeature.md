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

## React `useFlag` query hook

OpenFeature's `useFlag()` returns a structured object with `value` and
`reason`. Give the call its final object value and `flag-prune` folds the
destructured or member read.

Before:

```tsx
const { value: variant } = useFlag("checkout-version", "v1")
return variant === "v2" ? <CheckoutV2 /> : <CheckoutV1 />
```

A destructured `value` is read through a member access after resolution, so
supply the object shape the hook returns:

```sh
npx flag-prune --set 'useFlag("checkout-version")={ value: "v2", reason: "STATIC" }' src
```

When the code reads `useFlag(...).value` directly, the member read folds to
`"v2"` and the branch collapses to `<CheckoutV2 />`. A destructuring pattern
such as `const { value } = useFlag(...)` is not folded automatically; convert it
to a member read, or use a typed primitive hook such as `useBooleanFlagValue()`.

See [all provider guides](README.md) and the detailed [call matching
rules](../../flag-rules.md#calls).
