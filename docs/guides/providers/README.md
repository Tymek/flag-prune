# Feature flag provider cleanup guides

Use `flag-prune` to remove stale Unleash, LaunchDarkly, PostHog, Statsig, and
OpenFeature feature flags from JavaScript, TypeScript, React, and Node.js code.

Choose your provider:

| Provider                        | Common primitive APIs                                                       |
| ------------------------------- | --------------------------------------------------------------------------- |
| [Unleash](unleash.md)           | `useFlag("key")`, `unleash.isEnabled("key")`                                |
| [LaunchDarkly](launchdarkly.md) | `useBoolVariation("key", false)`, `client.variation("key", ...)`            |
| [PostHog](posthog.md)           | `posthog.isFeatureEnabled("key")`, `useFeatureFlagVariantKey("key")`        |
| [Statsig](statsig.md)           | `client.checkGate("key")`                                                   |
| [OpenFeature](openfeature.md)   | `client.getBooleanValue("key", false)`, `useBooleanFlagValue("key", false)` |

## Safe workflow

1. Confirm the final value in your feature flag provider.
2. Run `flag-prune` without `--write`.
3. Review the dry-run diff.
4. Run the same command with `--write`.
5. Run your project's typecheck, lint, and tests.

```sh
npx flag-prune --set 'client.isEnabled("old-feature")=true' src
npx flag-prune --set 'client.isEnabled("old-feature")=true' --write src
```

## Supported values

`flag-prune` replaces primitive results: booleans, strings, numbers, or `null`.
The configured call prefix must be static and exact. Later arguments may vary,
so a rule containing only the flag key can match calls that also receive
context or fallback values.

Do not replace a whole call that returns an object, such as a detailed
evaluation or variant result. Use a primitive-returning API, or refactor the
result to a primitive before pruning it.

Read [Flag rules](../../flag-rules.md) for complete matching details and
[Getting started](../../getting-started.md) for the general CLI workflow.
