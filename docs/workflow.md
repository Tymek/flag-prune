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

   Add `--flatten-blocks` when you want it to de-scope the blocks it leaves
   behind. See [Safety guarantees](safety.md#opt-in-block-de-scoping).

2. **Typecheck** - confirm the transform did not break types.

   ```sh
   tsc --noEmit
   ```

3. **Lint** - apply autofixes and surface newly dead or unreachable code your
   rules detect.

   ```sh
   eslint . --fix
   ```

4. **Format** - normalize whitespace so the mechanical diff is minimal.

   ```sh
   prettier --write .   # or biome format --write .
   ```

5. **Test** - run the suite to confirm behavior is unchanged for the flag's
   final value.

   ```sh
   npm test
   ```

6. **Dead-code removal** - `flag-prune` intentionally does not delete unused
   files, exports, or imports that are still referenced elsewhere. Run a
   dedicated tool such as [Knip](https://knip.dev/), [Fallow](https://fallow.dev/),
   or `ts-prune` to remove what is now unreachable across the project.

7. **LLM cleanup pass** - hand the result to an AI agent for the readability and
   scoping refactors described below.

A convenient one-liner for the deterministic steps:

```sh
npx flag-prune --set 'useFlag("new-checkout")=true' --write src \
  && tsc --noEmit \
  && eslint . --fix \
  && prettier --write . \
  && npm test
```

## The LLM cleanup pass

`flag-prune` is deliberately conservative. When it removes a branch, it keeps
enough structure to guarantee safety, which can leave code that is correct but
not yet idiomatic. Typical leftovers:

- A `let` declared for both branches that could now be a single `const`.
- A value assigned in a removed branch that can be inlined at its use.
- A block that could be de-scoped if you accept the readability trade-off (or
  that `--flatten-blocks` left in place because a name check failed).

These are judgment calls, so they are a good fit for an LLM rather than a
codemod.

### Example

After `flag-prune` resolves `hasFeature.newAccessControl` to `true` (with
`--flatten-blocks`), you might have:

```ts
export async function getSettings() {
  let user: Awaited<ReturnType<typeof authenticateAtLeast>>
  let permissions: AccessPermission[] | undefined

  const access = await authorizeAccess(["organization-settings"])
  permissions = access.permissions
  user = await getUserFromSessionOr404()

  return {
    showArxAdminTools: await canAccessArxAdminTools(user, permissions),
  }
}
```

An LLM can finish the cleanup into idiomatic code, which a deterministic tool
should not attempt automatically:

```ts
export async function getSettings() {
  const user = await getUserFromSessionOr404()
  const permissions = (await authorizeAccess(["organization-settings"])).permissions

  return {
    showArxAdminTools: await canAccessArxAdminTools(user, permissions),
  }
}
```

### Prompt

Give the agent the changed files and a clear, bounded instruction. A prompt that
works well:

```text
You are cleaning up code after an automated feature-flag removal. The behavior
is already correct; only improve readability without changing runtime behavior.

Apply only these safe refactors to the files I provide:
1. Convert a `let` that is now assigned exactly once into a `const`, moving the
   declaration to the assignment site.
2. Inline a local variable that is only read once, when it has no observable
   side effects on move.
3. Remove a redundant block `{ ... }` by de-scoping its declarations, but only
   when no declared name collides with or shadows an outer binding and no name
   is referenced outside the block.
4. Collapse trivially nested conditionals left by the removal.

Rules:
- Preserve evaluation order and all side effects (calls, awaits, getters).
- Do not touch behavior, types, exports, or public APIs.
- Do not reorder statements across an `await` or a side-effecting call.
- If a change is not clearly safe, leave the code as-is.
- Return only the edited files.

After you finish, I will re-run typecheck, lint, format, and tests.
```

Always re-run the deterministic checks (typecheck, lint, format, test) after the
LLM pass to confirm the refactor preserved behavior.
