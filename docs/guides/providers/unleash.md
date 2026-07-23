# Remove Unleash feature flags

Remove stale Unleash feature flags from React and Node.js code with
`flag-prune`. See the official [Unleash Node.js SDK
documentation](https://docs.getunleash.io/sdks/node) and [Unleash React SDK
documentation](https://docs.getunleash.io/sdks/react).

## React `useFlag`

Before:

```tsx
const enabled = useFlag("new-checkout")
return enabled ? <CheckoutV2 /> : <CheckoutV1 />
```

Preview a flag whose final value is `true`:

```sh
npx flag-prune --set 'useFlag("new-checkout")=true' src
```

Result:

```tsx
return <CheckoutV2 />
```

After reviewing the diff:

```sh
npx flag-prune --set 'useFlag("new-checkout")=true' --write src
```

## Node.js `isEnabled`

```ts
if (unleash.isEnabled("beta-search", context)) {
  showNewSearch()
} else {
  showOldSearch()
}
```

The rule needs only the stable prefix:

```sh
npx flag-prune --set 'unleash.isEnabled("beta-search")=false' src
```

This matches even though `context` follows the key. Required side effects in
later arguments are preserved while the branch is simplified.

## Variants with `getVariant` and `useVariant`

`getVariant()` and `useVariant()` return a variant object with `name`,
`enabled`, and an optional `payload`. Give the call its final object value and
`flag-prune` folds each static member read.

Before:

```ts
const variant = getVariant("checkout")
if (variant.enabled && variant.name === "treatment") {
  showTreatment()
} else {
  showControl()
}
```

Command:

```sh
npx flag-prune --set 'getVariant("checkout")={ name: "treatment", enabled: true }' src
```

Result:

```ts
showTreatment()
```

Access the payload the same way. With
`useVariant("checkout")={ enabled: true, payload: { type: "json", value: "{}" } }`,
a read of `variant.payload.value` folds to `"{}"`. If the variant object is also
passed somewhere as a whole value, its declaration is kept so object identity is
preserved.

See [all provider guides](README.md) and the detailed [call matching
rules](../../flag-rules.md#calls).
