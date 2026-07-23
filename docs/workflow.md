# Recommended workflow

`flag-prune` does one job: the mechanical, deterministic part of removing a
feature flag. It is most effective as one step in a short pipeline that ends
with your project's own checks and, optionally, a judgment-based cleanup pass by
an AI agent.

The guiding split is:

- **Deterministic tools** handle the repetitive, provable transformations. The
  same input and rules always produce the same output.
- **An LLM pass** handles the subjective refactors that need judgment and would
  be unsafe to automate, such as merging declarations or renaming for clarity.

Keeping these separate makes large cleanups faster, cheaper, and easier to
review than asking an agent to do everything.

## The pipeline

Run these steps in order and commit between them so each diff stays small.

1. **`flag-prune`** - replace the flag and remove the code that can no longer
   run. Preview first, review the diff, then write.

   ```sh
   npx flag-prune --set 'useFlag("new-checkout")=true' src
   npx flag-prune --set 'useFlag("new-checkout")=true' --write src
   ```

   By default it also de-scopes the blocks it can safely flatten; pass
   `--no-flatten-blocks` to keep them. See
   [Safety guarantees](safety.md#lexical-scope-is-de-scoped-only-when-safe).

2. **Typecheck** - confirm the transform did not break types, for example: `tsc --noEmit`
3. **Lint** - apply autofixes and surface newly dead or unreachable code your
   rules detect.
4. **Format** - normalize whitespace so the mechanical diff is minimal. When
   `flag-prune` reprints a moved statement it may add a semicolon or switch a
   quote style; the formatter (Prettier, Biome, or ESLint) normalizes this, so
   run it before review.
5. **Test** - run the suite to confirm behavior is unchanged for the flag's
   final value.
6. **Dead-code removal** - `flag-prune` intentionally does not delete unused
   files, exports, or imports that are still referenced elsewhere. Run a
   dedicated tool such as [Fallow](https://fallow.dev/) or [Knip](https://knip.dev/)
   to remove what is now unreachable across the project.
7. **LLM cleanup pass** - hand the result to an AI agent for the readability and
   scoping refactors described below. Do this in a **separate commit or pull
   request** so the deterministic changes stay reviewable on their own and the
   judgment-based edits can be reviewed independently.

## The LLM cleanup pass

`flag-prune` is deliberately conservative. When it removes a branch, it keeps
enough structure to guarantee safety, which can leave code that is correct but
not yet idiomatic. Typical leftovers:

- A `let` declared for both branches that could now be a single `const`.
- A value assigned in a removed branch that can be inlined at its use.
- A conditional left trivially nested after a branch was removed.

These are judgment calls, so they are a good fit for an LLM rather than a
codemod.

### Example

Considering initial code:

```ts
export async function getSettings() {
  let user: Awaited<UserType>

  if (flagValue) {
    user = await getUser()
  } else {
    user = await getLegacyUser()
  }
  return verifyAccess(user)
}
```

After `flag-prune` resolves `flagValue` to `true`, you might have:

```ts
export async function getSettings() {
  let user: Awaited<UserType>
  user = await getUser()

  return verifyAccess(user)
}
```

An LLM can finish the cleanup into idiomatic code, which a deterministic tool
will not attempt:

```ts
export async function getSettings() {
  const user = await getUser()

  return verifyAccess(user)
}
```

### Prompt

Give the agent the changed files and a clear, bounded instruction. A prompt that
works well:

```text
Clean up code left by an automated feature-flag removal. Improve readability only; do not change runtime behavior.

Safe refactors: merge a `let` that is now assigned exactly once into a `const`; inline a variable that is read once; collapse a trivially nested conditional.

Preserve evaluation order and every side effect (calls, awaits, getters). Do not change behavior, types, or exports. If a change is not clearly safe, leave it. Return only the edited files.
```
