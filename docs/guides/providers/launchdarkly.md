# Remove LaunchDarkly feature flags

Remove stale LaunchDarkly feature flags from React and JavaScript code with
`flag-prune`. See the official [React Web SDK
documentation](https://launchdarkly.com/docs/sdk/client-side/react/react-web)
and [flag evaluation
documentation](https://launchdarkly.com/docs/sdk/features/evaluating).

## React typed variation hooks

```tsx
const enabled = useBoolVariation("new-dashboard", false)
return enabled ? <NewDashboard /> : <OldDashboard />
```

Preview, then write after reviewing the diff:

```sh
npx flag-prune --set 'useBoolVariation("new-dashboard")=true' src
npx flag-prune --set 'useBoolVariation("new-dashboard")=true' --write src
```

The fallback argument may differ between call sites because it follows the
configured flag-key prefix. Typed string and number hooks work with replacement
values of the same primitive type.

## JavaScript `variation`

```ts
const layout = client.variation("checkout-layout", context, "standard")

if (layout === "treatment") {
  showTreatment()
}
```

Preview the final string value:

```sh
npx flag-prune --set 'client.variation("checkout-layout")=treatment' src
```

The context and fallback may vary. The client name, method, and flag key must
match exactly. LaunchDarkly React Web SDK v4 deprecates `useFlags`; prefer typed
hooks for new code and straightforward primitive replacement.

See [all provider guides](README.md) and the detailed [call matching
rules](../../flag-rules.md#calls).
