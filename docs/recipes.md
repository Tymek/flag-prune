# Recipes

These examples are provider-agnostic. Replace the selectors and paths with the exact shapes used in your codebase.

For Unleash, LaunchDarkly, PostHog, Statsig, and OpenFeature commands, see the
[feature flag provider guides](guides/providers/README.md).

## Remove a hook flag

Source:

```tsx
const enabled = useFlag("new-checkout");

return enabled ? <NewCheckout /> : <CurrentCheckout />
```

Command:

```sh
npx flag-prune --set 'useFlag("new-checkout")=false' --write src
```

Result:

```tsx
return <CurrentCheckout />
```

## Remove a client method flag

Source:

```ts
if (client.isEnabled("new-checkout", loadContext())) {
  startNewCheckout()
} else {
  startCurrentCheckout()
}
```

Command:

```sh
npx flag-prune \
  --set 'client.isEnabled("new-checkout")=true' \
  --write \
  src
```

Result:

```ts
loadContext()
startNewCheckout()
```

The required `loadContext()` evaluation remains even though its result is no longer needed.

## Remove an imported constant

Source:

```ts
import { NEW_CHECKOUT as enabled, metadata } from "./flags";

if (enabled) {
  startNewCheckout()
} else {
  startCurrentCheckout()
}

metadata()
```

Command:

```sh
npx flag-prune --set './flags#NEW_CHECKOUT=false' --write src
```

Result:

```ts
import { metadata } from "./flags"

startCurrentCheckout()
metadata()
```

If the configured binding is the final import specifier, `flag-prune` leaves a side-effect import by default:

```ts
import "./flags"
```

Only use `--remove-side-effect-imports` when the module is proven side-effect-free.

## Resolve a string variant

Source:

```ts
const variant = getVariant("checkout")

if (variant === "treatment") {
  showTreatment()
} else {
  showControl()
}
```

Command:

```sh
npx flag-prune \
  --set 'getVariant("checkout")=treatment' \
  --write \
  src
```

Result:

```ts
showTreatment()
```

## Resolve a variant object

Some SDKs return a variant object rather than a bare string. Give the flag its
final object value and `flag-prune` folds each static member read.

Source:

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
npx flag-prune \
  --set 'getVariant("checkout")={ enabled: true, name: "treatment" }' \
  --write \
  src
```

Result:

```ts
showTreatment()
```

If the object is also used as a whole value, the declaration is kept and only
the member reads are folded:

```ts
const variant = { enabled: true, name: "treatment" }
track(variant)
showTreatment()
```

## Remove a conditional object spread

A flag inside an object spread often folds to a value that spreads nothing.

Source:

```ts
const content = {
  state: null,
  ...(flagValue ? {} : { permission: 1 }),
}
```

Command:

```sh
npx flag-prune --set 'flagValue=true' --write src
```

Result:

```ts
const content = {
  state: null,
}
```

The `...({})` spread is removed because it contributes no properties. See
[Empty object spreads are removed](safety.md#empty-object-spreads-are-removed)
for the exact rules.

## Resolve a numeric limit

Source:

```ts
if (limits.maxSeats >= 10) {
  showEnterpriseControls()
} else {
  showStarterControls()
}
```

Command:

```sh
npx flag-prune --set 'limits.maxSeats=25' --write src
```

Result:

```ts
showEnterpriseControls()
```

## Resolve a nullable override

Source:

```ts
const theme = readThemeOverride() ?? defaultTheme
```

Command:

```sh
npx flag-prune --set 'readThemeOverride()=null' --write src
```

Result:

```ts
const theme = defaultTheme
```

## Remove several flags in one migration

```sh
npx flag-prune \
  --set 'useFlag("new-checkout")=false' \
  --set 'getVariant("checkout-copy")=control' \
  --set './flags#SHOW_CHECKOUT_BADGE=false' \
  --write \
  src
```

Related rules are simplified together, which can remove branches that depend on combinations such as `A && B`.

## Preview a pull-request migration

```sh
npx flag-prune \
  --set 'useFlag("new-checkout")=false' \
  --diff \
  src
```

Dry-run and diff output are already the defaults, but spelling them out can make a saved migration command easier to understand.

## Check that cleanup has been applied

```sh
npx flag-prune \
  --set 'useFlag("new-checkout")=false' \
  --check \
  --no-diff \
  src
```

Exit code `1` means files would change. This is useful while a cleanup branch is being prepared or when enforcing a known final value in CI.

## Produce JSON for an agent or script

```sh
npx flag-prune \
  --set 'useFlag("new-checkout")=false' \
  --json \
  src > flag-prune-report.json
```

The JSON includes an aggregate report and a per-file report.
