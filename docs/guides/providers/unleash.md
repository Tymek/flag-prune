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

`getVariant()` and `useVariant()` return objects. Do not replace the complete
call with a primitive; refactor it first or remove the variant manually.

See [all provider guides](README.md) and the detailed [call matching
rules](../../flag-rules.md#calls).
