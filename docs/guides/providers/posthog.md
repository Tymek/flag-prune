# Remove PostHog feature flags

Remove stale PostHog feature flags from web and React code with `flag-prune`.
See PostHog's official [feature flag
documentation](https://posthog.com/docs/feature-flags/adding-feature-flag-code).

## Web `isFeatureEnabled`

```ts
if (posthog.isFeatureEnabled("advanced-metrics")) {
  showAdvancedMetrics()
} else {
  showBasicMetrics()
}
```

Preview, then write after reviewing the diff:

```sh
npx flag-prune --set 'posthog.isFeatureEnabled("advanced-metrics")=true' src
npx flag-prune --set 'posthog.isFeatureEnabled("advanced-metrics")=true' --write src
```

## React variant hook

```tsx
const variant = useFeatureFlagVariantKey("paywall-variant")
return variant === "soft" ? <SoftPaywall /> : <HardPaywall />
```

Preview the final string variant:

```sh
npx flag-prune --set 'useFeatureFlagVariantKey("paywall-variant")=soft' src
```

For boolean React flags, use the same pattern with
`useFeatureFlagEnabled("flag-key")`.

APIs such as `getFeatureFlagResult()` return an object. Do not replace the
complete result with a primitive. Use a primitive-returning API, or refactor the
object access first.

See [all provider guides](README.md) and the detailed [call matching
rules](../../flag-rules.md#calls).
