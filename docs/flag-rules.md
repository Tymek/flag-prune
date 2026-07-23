# Flag rules

A flag rule identifies an exact source shape and assigns its final primitive value.

```text
selector[=value]
```

The value defaults to `true` when omitted.

## Rule forms

| Source shape   | CLI rule                              | Library definition                                                                |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| Identifier     | `FLAG=false`                          | `{ identifier: "FLAG", value: false }`                                            |
| Member access  | `features.newUi=false`                | `{ identifier: "features", path: ["newUi"], value: false }`                       |
| Imported value | `./flags#NEW_UI=false`                | `{ module: "./flags", export: "NEW_UI", value: false }`                           |
| Call           | `useFlag("new-ui")=false`             | `{ call: "useFlag", arguments: ["new-ui"], value: false }`                        |
| Dotted call    | `client.isEnabled("new-ui")=false`    | `{ call: "client.isEnabled", arguments: ["new-ui"], value: false }`               |
| Imported call  | `flag-client#useFlag("new-ui")=false` | `{ module: "flag-client", call: "useFlag", arguments: ["new-ui"], value: false }` |

Quote call rules in your shell so parentheses and spaces are not interpreted.

## Identifiers and members

Match a program-level or unresolved identifier:

```sh
npx flag-prune --set 'NEW_CHECKOUT=false' src
```

Match a static member path:

```sh
npx flag-prune --set 'features.checkout.newUi=false' src
```

This matches static dot access and equivalent optional access:

```ts
features.checkout.newUi
features?.checkout?.newUi
```

Computed dynamic keys do not match:

```ts
features.checkout[key]
```

A computed string literal is still static and can match:

```ts
features["checkout"].newUi
```

## Imported values

Use the exact module specifier, `#`, and the imported export name:

```sh
npx flag-prune --set './flags#NEW_CHECKOUT=false' src
```

Given:

```ts
import { NEW_CHECKOUT as checkoutEnabled } from "./flags"
```

The rule matches `checkoutEnabled` because import aliases are resolved. A local parameter or variable that shadows the alias is not changed.

Namespace imports are supported:

```ts
import * as flags from "./flags"

if (flags.NEW_CHECKOUT) {
  // ...
}
```

The same `./flags#NEW_CHECKOUT=false` rule matches the namespace member.

Default imports use `default` as the export name in the library definition:

```ts
{
  module: "flag-client",
  export: "default",
  path: ["newCheckout"],
  value: false,
}
```

## Calls

For SDK examples, see the [Unleash, LaunchDarkly, PostHog, Statsig, and
OpenFeature guides](guides/providers/README.md).

Calls match an exact static callee and an exact required argument prefix:

```sh
npx flag-prune --set 'client.isEnabled("new-ui")=false' src
```

This matches:

```ts
client.isEnabled("new-ui")
client.isEnabled("new-ui", context)
client.isEnabled("new-ui", loadContext())
```

It does not match:

```ts
client.isEnabled()
client.isEnabled("other")
client.isEnabled(flagName)
```

Configured arguments can be strings, numbers, booleans, negative numbers, or `null`:

```sh
npx flag-prune --set 'resolveExperiment("checkout", 2, true, null)=treatment' src
```

Dynamic configured arguments are rejected because they would make matching ambiguous:

```sh
# Invalid
npx flag-prune --set 'useFlag(flagName)=false' src
```

### Additional caller arguments

Arguments after the configured prefix do not participate in matching. Their required evaluation is preserved when the flag call is removed.

```ts
if (client.isEnabled("new-ui", loadContext())) {
  renderNewUi()
}
```

With the value `true`, the result retains the context call:

```ts
loadContext()
renderNewUi()
```

Pure trailing values can disappear. Calls, getters, computed keys, spreads, and other observable evaluation are retained.

### Imported calls

Limit a call rule to one imported binding by adding the module specifier:

```sh
npx flag-prune --set 'flag-client#useFlag("new-ui")=false' src
```

Aliases are resolved, and shadowed functions are not matched.

Without `module`, a call rule binds to a program-level import or declaration when one exists. Otherwise, an unresolved function name may match. Dotted calls such as `client.isEnabled` can also match a local parameter or object binding with that exact static path.

## Replacement values

Supported values are:

| Kind    | Examples                                |
| ------- | --------------------------------------- |
| Boolean | `true`, `false`                         |
| Number  | `0`, `25`, `-1`, `3.5`                  |
| Null    | `null`                                  |
| String  | `treatment`, `'pro tier'`, `"pro tier"` |

Unquoted tokens that are not booleans, numbers, or `null` are strings:

```sh
npx flag-prune --set 'getVariant("checkout")=treatment' src
```

Quote a string value when it contains spaces or shell-sensitive characters:

```sh
npx flag-prune --set 'getVariant("checkout")="new treatment"' src
```

## Matching is exact and scope-aware

`flag-prune` does not use fuzzy text replacement.

- Property names and required arguments must match exactly.
- Import module specifiers must match exactly.
- Imported aliases are followed through their binding.
- Local shadowing is preserved.
- Reassigned call-result bindings are not propagated as constants.
- Dynamic keys and arguments stay untouched.

These constraints are what make the transform repeatable and conservative.

## Multiple rules

Repeat `--set`:

```sh
npx flag-prune \
  --set 'A=true' \
  --set 'B=false' \
  --set 'getVariant("checkout")=control' \
  src
```

Use `--` before a target whose name begins with `-`:

```sh
npx flag-prune --set 'FLAG=false' -- --generated.ts
```
