import { describe, expect, it } from "vitest"
import { transform, validateConfig, type TransformOptions } from "../src/index.js"

function run(source: string, flags: TransformOptions["flags"] = [], options: Partial<TransformOptions> = {}) {
  return transform(source, { flags, filename: "fixture.tsx", ...options })
}

it("parses generic arrow parameters in .ts files without JSX ambiguity", () => {
  const source = "export const make = <T>({ ...args }: { value?: T }) => args"
  expect(run(source, [], { filename: "fixture.ts" })).toMatchObject({ code: source, changed: false })
})

it("prints changed Babel 8 TypeScript interface heritage", () => {
  const source = "interface Props extends React.HTMLAttributes<HTMLButtonElement> {}\nif (FLAG) yes()"
  const result = run(source, [{ identifier: "FLAG", value: true }])
  expect(result.code).toContain("interface Props extends React.HTMLAttributes<HTMLButtonElement>")
  expect(result.code).toContain("yes();")
})

it("preserves source line endings and defaults to LF", () => {
  const flags = [{ identifier: "FLAG", value: false }]
  expect(run("if (FLAG) yes(); else no();", flags).code).toBe("no();\n")
  expect(run("if (FLAG) yes(); else no();\n", flags).code).toBe("no();\n")
  expect(run("if (FLAG) yes(); else no();\r\n", flags).code).toBe("no();\r\n")
})

describe("feature flag matching", () => {
  it("replaces member flags and collapses branches", () => {
    const result = run(
      "if (hasFeature.newAccessControl) { useNewAccess() } else { useLegacyAccess() }",
      [{ identifier: "hasFeature", path: ["newAccessControl"], value: true }],
    )
    expect(result.code).toBe("useNewAccess();\n")
    expect(result.report.flagsReplaced).toBe(1)
    expect(result.report.deadBranchesRemoved).toBe(1)
  })

  it("matches aliased imports, removes only dead specifier, and respects shadowing", () => {
    const source = `import { NEW_ACCESS as enabled, metadata } from "./flags"
if (enabled) newAccess()
function test(enabled: boolean) {
  if (enabled) localPath()
}
metadata()
`
    const result = run(source, [{ module: "./flags", export: "NEW_ACCESS", value: true }])
    expect(result.code).toContain('import { metadata } from "./flags";')
    expect(result.code).toContain("newAccess();")
    expect(result.code).toContain("if (enabled)")
    expect(result.report.flagsReplaced).toBe(1)
    expect(result.report.importsRemoved).toBe(1)
  })

  it("preserves module evaluation when removing the last configured import binding", () => {
    const result = run('import { FLAG } from "./flags";\nif (FLAG) yes(); else no();', [
      { module: "./flags", export: "FLAG", value: false },
    ])
    expect(result.code).toBe('import "./flags";\nno();\n')
    expect(result.report.importsRemoved).toBe(1)
  })

  it("preserves the file's dominant quote style for a rewritten import", () => {
    const result = run("import { FLAG } from './flags';\nif (FLAG) yes(); else no();", [
      { module: "./flags", export: "FLAG", value: false },
    ])
    expect(result.code).toBe("import './flags';\nno();\n")
  })

  it("removes the whole import only with explicit side-effect approval", () => {
    const result = run(
      'import { FLAG } from "./flags";\nif (FLAG) yes(); else no();',
      [{ module: "./flags", export: "FLAG", value: false }],
      { removeSideEffectImports: true },
    )
    expect(result.code).toBe("no();\n")
  })

  it("matches namespace imports", () => {
    const result = run('import * as features from "./flags";\nfeatures.FLAG ? yes() : no();', [
      { module: "./flags", export: "FLAG", value: true },
    ])
    expect(result.code).toBe('import "./flags";\nyes();\n')
  })

  it("matches approved calls with an exact static argument prefix", () => {
    const source = `import { featureEnabled } from "./flags"
if (featureEnabled("new-access")) yes(); else no()
if (featureEnabled(dynamicName)) dynamic()
`
    const result = run(source, [
      { module: "./flags", call: "featureEnabled", arguments: ["new-access"], value: true },
    ])
    expect(result.code).toContain("yes();")
    expect(result.code).toContain("featureEnabled(dynamicName)")
    expect(result.code).toContain('import { featureEnabled } from "./flags"')
    expect(result.report.flagsReplaced).toBe(1)
  })

  it("allows additional call arguments and preserves their effects", () => {
    const source = `if (client.isEnabled("new-ui", context)) withContext()
if (client.isEnabled("new-ui", loadContext())) withLoadedContext()
if (client.isEnabled("new-ui", object.context)) withGetterContext()
if (client.isEnabled("new-ui", ...loadContexts())) withSpreadContext()`
    const result = run(source, [
      { call: "client.isEnabled", arguments: ["new-ui"], value: true },
    ])
    expect(result.code).toBe(
      "context;\nwithContext();\nloadContext();\nwithLoadedContext();\nobject.context;\nwithGetterContext();\n[...loadContexts()];\nwithSpreadContext();\n",
    )
    expect(result.report).toMatchObject({ flagsReplaced: 4, deadBranchesRemoved: 4 })
    expect(result.report.effectsPreserved).toBeGreaterThanOrEqual(4)
  })

  it("preserves trailing argument effects when removing an assigned result", () => {
    const source = `const enabled = useFlag("new-ui", loadContext())
if (enabled) yes(); else no()`
    const result = run(source, [{ call: "useFlag", arguments: ["new-ui"], value: false }])
    expect(result.code).toBe("loadContext();\nno();\n")
  })

  it("drops pure context literals but preserves computed context effects", () => {
    const source = `function run(email: string) {
  if (client.isEnabled("new-ui", { email })) yes()
  if (client.isEnabled("new-ui", { [loadKey()]: email })) computed()
}`
    const result = run(source, [
      { call: "client.isEnabled", arguments: ["new-ui"], value: true },
    ])
    expect(result.code).not.toContain("{ email }")
    expect(result.code).toContain("loadKey();")
    expect(result.code).toContain("computed()")
  })

  it("keeps exact required arguments and rejects missing or different keys", () => {
    const source = `client.isEnabled()
client.isEnabled("other", context)`
    expect(run(source, [
      { call: "client.isEnabled", arguments: ["new-ui"], value: true },
    ])).toMatchObject({ code: source, changed: false })
  })

  it("resolves a string-valued flag through strict equality", () => {
    const source = `const variant = getVariant("checkout")
if (variant === "treatment") showNew(); else showOld()`
    const treatment = run(source, [{ call: "getVariant", arguments: ["checkout"], value: "treatment" }])
    expect(treatment.code).toBe("showNew();\n")
    const control = run(source, [{ call: "getVariant", arguments: ["checkout"], value: "control" }])
    expect(control.code).toBe("showOld();\n")
  })

  it("treats a non-empty string flag as truthy and null as falsy", () => {
    const truthy = run("if (readTier()) pro(); else free()", [{ call: "readTier", value: "enterprise" }])
    expect(truthy.code).toBe("pro();\n")
    const nullish = run("if (readTier()) pro(); else free()", [{ call: "readTier", value: null }])
    expect(nullish.code).toBe("free();\n")
  })

  it("resolves a numeric member flag through comparison", () => {
    const source = "if (limits.maxSeats >= 10) enterprise(); else starter()"
    const result = run(source, [{ identifier: "limits", path: ["maxSeats"], value: 25 }])
    expect(result.code).toBe("enterprise();\n")
    expect(run(source, [{ identifier: "limits", path: ["maxSeats"], value: 3 }]).code).toBe("starter();\n")
  })

  it("folds nullish coalescing around a resolved flag", () => {
    const source = "if (config.featureToggles.newList ?? false) newList(); else oldList()"
    const enabled = run(source, [{ identifier: "config", path: ["featureToggles", "newList"], value: true }])
    expect(enabled.code).toBe("newList();\n")
    const disabled = run(source, [{ identifier: "config", path: ["featureToggles", "newList"], value: false }])
    expect(disabled.code).toBe("oldList();\n")
    const nullable = run("const value = readConfig() ?? fallback", [{ call: "readConfig", value: null }])
    expect(nullable.code).toBe("const value = fallback\n")
  })

  it("is idempotent for a string-valued flag migration", () => {
    const source = `const variant = getVariant("checkout")
if (variant === "treatment") showNew(); else showOld()`
    const once = run(source, [{ call: "getVariant", arguments: ["checkout"], value: "treatment" }]).code
    const twice = run(once, [{ call: "getVariant", arguments: ["checkout"], value: "treatment" }]).code
    expect(twice).toBe(once)
  })

  it("inlines a fixed call result and removes its dead branch and binding", () => {
    const source = `const x = useFlag("y")
if (x) {
  newPath()
} else {
  oldPath()
}`
    const result = run(source, [{ call: "useFlag", arguments: ["y"], value: true }])
    expect(result.code).toBe("newPath();\n")
    expect(result.report).toMatchObject({ flagsReplaced: 1, deadBranchesRemoved: 1, bindingsRemoved: 1 })
  })

  it("cleans an unaliased imported call while preserving module evaluation", () => {
    const source = `import { useFlag } from "flag-client"
const x = useFlag("y")
if (x) yes(); else no()`
    const result = run(source, [{ call: "useFlag", arguments: ["y"], value: true }])
    expect(result.code).toBe('import "flag-client";\nyes();\n')
  })

  it("preserves exported bindings while propagating their local reads", () => {
    const source = `const x = useFlag("y")
export { x }
if (x) yes(); else no()`
    const result = run(source, [{ call: "useFlag", arguments: ["y"], value: false }])
    expect(result.code).toContain("const x = false")
    expect(result.code).toContain("export { x }")
    expect(result.code).toContain("no();")
  })

  it("matches exact dotted calls without provider-specific behavior", () => {
    const source = `if (client.isEnabled("new-ui")) yes(); else no()
if (client.isEnabled("other")) other()`
    const result = run(source, [
      { call: "client.isEnabled", arguments: ["new-ui"], value: false },
    ])
    expect(result.code).toContain("no();")
    expect(result.code).toContain('client.isEnabled("other")')
    expect(result.report.flagsReplaced).toBe(1)
  })

  it("matches dotted calls rooted in local parameters", () => {
    const source = `function render(client: Client, context: Context) {
  if (client.isEnabled("new-ui", context)) yes(); else no()
}`
    const result = run(source, [
      { call: "client.isEnabled", arguments: ["new-ui"], value: false },
    ])
    expect(result.code).toBe("function render(client: Client, context: Context) {\n  no();\n}\n")
  })

  it("matches exact this-rooted method calls", () => {
    const source = `class Service {
  run() {
    if (this.flagResolver.isEnabled("new-ui")) yes(); else no()
  }
}`
    const result = run(source, [
      { call: "this.flagResolver.isEnabled", arguments: ["new-ui"], value: true },
    ])
    expect(result.code).toContain("run() {\n    yes();\n  }")
  })

  it("does not match a shadowed direct function call", () => {
    const source = `function render(useFlag: (key: string) => boolean) {
  return useFlag("new-ui")
}`
    expect(run(source, [{ call: "useFlag", arguments: ["new-ui"], value: true }])).toMatchObject({
      code: source,
      changed: false,
    })
  })

  it("resolves imported call aliases and preserves shadowed functions", () => {
    const source = `import { useFlag as readFlag } from "./flags"
const enabled = readFlag("new-ui")
function local(readFlag: (key: string) => boolean) {
  return readFlag("new-ui")
}
if (enabled) yes(); else no()`
    const result = run(source, [
      { module: "./flags", call: "useFlag", arguments: ["new-ui"], value: false },
    ])
    expect(result.code).toContain('import "./flags";')
    expect(result.code).toContain('return readFlag("new-ui")')
    expect(result.code).toContain("no();")
    expect(result.report.flagsReplaced).toBe(1)
  })

  it("matches a method on an imported default client", () => {
    const source = `import client from "flag-client"
const enabled = client.isEnabled("new-ui")
if (enabled) yes(); else no()`
    const result = run(source, [
      { module: "flag-client", call: "default.isEnabled", arguments: ["new-ui"], value: true },
    ])
    expect(result.code).toBe('import "flag-client";\nyes();\n')
  })

  it("does not inline a reassigned call result", () => {
    const source = `let enabled = useFlag("new-ui")
enabled = override()
if (enabled) yes(); else no()`
    const result = run(source, [{ call: "useFlag", arguments: ["new-ui"], value: true }])
    expect(result.code).toContain("let enabled = true")
    expect(result.code).toContain("enabled = override()")
    expect(result.code).toContain("if (enabled)")
  })

  it("removes only the inlined binding from a multi-declarator statement", () => {
    const result = run("const x = useFlag('y'), keep = load(); if (x) yes();", [
      { call: "useFlag", arguments: ["y"], value: false },
    ])
    expect(result.code).toBe("const keep = load();\n")
  })

  it("returns untouched dynamic source byte-for-byte", () => {
    const source = "if(featureEnabled(flagName)){ newAccess() }else{ legacyAccess() }\n"
    const result = run(source, [
      { call: "featureEnabled", arguments: ["new-access"], value: true },
    ])
    expect(result).toMatchObject({ code: source, changed: false })
  })

  it("never replaces a shadowed global member root", () => {
    const source = `if (hasFeature.flag) globalPath()
function run(hasFeature: FeatureSet) {
  if (hasFeature.flag) localPath()
}`
    const result = run(source, [{ identifier: "hasFeature", path: ["flag"], value: false }])
    expect(result.code).not.toContain("globalPath")
    expect(result.code).toContain("hasFeature.flag")
    expect(result.report.flagsReplaced).toBe(1)
  })

  it("matches optional and plain member access with one rule", () => {
    const flags = [{ identifier: "hasFeature", path: ["flag"], value: true }]
    expect(run("if (hasFeature?.flag) yes();", flags).code).toBe("yes();\n")
    expect(run("if (hasFeature.flag) yes();", flags).code).toBe("yes();\n")
    const call = [{ call: "client.isEnabled", arguments: ["new-ui"], value: true }]
    expect(run('client?.isEnabled("new-ui", ctx) ? a() : b()', call).code).toContain("a()")
  })
})

describe("object and variant values", () => {
  it("folds member reads of a variant object and collapses the branch", () => {
    const source = `const variant = getVariant("checkout")
if (variant.enabled && variant.name === "treatment") showNew(); else showOld()`
    const result = run(source, [
      { call: "getVariant", arguments: ["checkout"], value: { enabled: true, name: "treatment" } },
    ])
    expect(result.code).toBe("showNew();\n")
    expect(result.report.flagsReplaced).toBe(1)
    expect(result.report.deadBranchesRemoved).toBe(1)
  })

  it("folds a direct member chain without a binding", () => {
    const result = run('applyTheme(useFlag("theme").payload.mode)', [
      { call: "useFlag", arguments: ["theme"], value: { payload: { mode: "dark" } } },
    ])
    expect(result.code).toBe('applyTheme("dark")\n')
  })

  it("folds array index reads of an array-valued flag", () => {
    const result = run('const first = getWeights("split")[0]', [
      { call: "getWeights", arguments: ["split"], value: [10, 20] },
    ])
    expect(result.code).toBe("const first = 10\n")
  })

  it("retains the declaration and object identity for whole-object uses", () => {
    const source = `const variant = getVariant("checkout")
logVariant(variant)
if (variant.enabled) newUi(); else oldUi()`
    const result = run(source, [
      { call: "getVariant", arguments: ["checkout"], value: { enabled: true, name: "t" } },
    ])
    expect(result.code).toContain('const variant = {\n  enabled: true,\n  name: "t"\n}')
    expect(result.code).toContain("logVariant(variant)")
    expect(result.code).toContain("newUi();")
    expect(result.code).not.toContain("oldUi()")
    expect(result.report.bindingsRemoved).toBe(0)
  })

  it("removes the binding when every member read is folded", () => {
    const source = `const variant = getVariant("checkout")
if (variant.enabled) newUi(); else oldUi()`
    const result = run(source, [
      { call: "getVariant", arguments: ["checkout"], value: { enabled: false } },
    ])
    expect(result.code).toBe("oldUi();\n")
    expect(result.report.bindingsRemoved).toBe(1)
  })

  it("quotes non-identifier object keys and preserves them for whole uses", () => {
    const result = run('send(getConfig("x"))', [
      { call: "getConfig", arguments: ["x"], value: { "content-type": "json", nested: [1, true, null] } },
    ])
    expect(result.code).toContain('"content-type": "json"')
    expect(result.code).toContain("nested: [1, true, null]")
  })

  it("is idempotent for a variant migration", () => {
    const source = `const variant = getVariant("checkout")
if (variant.name === "treatment") showNew(); else showOld()`
    const flags = [{ call: "getVariant", arguments: ["checkout"], value: { name: "treatment" } }]
    const once = run(source, flags).code
    const twice = run(once, flags).code
    expect(twice).toBe(once)
  })

  it("does not fold member reads on unknown object shapes", () => {
    const source = 'const enabled = getVariant("x").enabled'
    const result = run(source, [{ call: "getVariant", arguments: ["x"], value: { name: "t" } }])
    expect(result.code).toContain(".enabled")
    expect(result.code).toContain('name: "t"')
  })
})

describe("expression safety", () => {
  it.each([
    ["const value = !!true", "const value = true\n"],
    ["const value = !false", "const value = true\n"],
    ["const value = !!!true", "const value = false\n"],
    ["const value = true === false", "const value = false\n"],
    ["const value = true !== false", "const value = true\n"],
  ])("folds %s", (source, expected) => {
    expect(run(source).code).toBe(expected)
  })

  it("preserves unknown values as well as calls and getter reads", () => {
    for (const source of [
      "const a = load() || true",
      "const b = load() && false",
      "const c = object.enabled || true",
    ]) {
      expect(run(source)).toMatchObject({ code: source, changed: false })
    }
  })

  it("does not introduce calls hidden by short circuiting", () => {
    expect(run("const a = true || load(); const b = false && load()").code).toBe(
      "const a = true; const b = false\n",
    )
  })

  it("does not apply boolean identities to unknown non-booleans", () => {
    const source = "const a = value && true; const b = value || false"
    expect(run(source)).toMatchObject({ code: source, changed: false })
  })

  it("applies identities and complements to stable typed booleans", () => {
    const source = `const flag: boolean = read()
const a = flag && true
const b = flag || false
const c = flag && !flag
const d = flag || !flag`
    const result = run(source)
    expect(result.code).toContain("const a = flag")
    expect(result.code).toContain("const b = flag")
    expect(result.code).toContain("const c = false")
    expect(result.code).toContain("const d = true")
  })

  it("uses bounded symbolic equivalence for pure propositional formulas", () => {
    const source = `declare const flagA: boolean
declare const flagB: boolean
const one = (flagA && flagB) || (flagA && !flagB)
const two = (flagA || flagB) && (flagA || !flagB)
const three = (flagA && !flagA) || flagB`
    const result = run(source)
    expect(result.code).toContain("const one = flagA")
    expect(result.code).toContain("const two = flagA")
    expect(result.code).toContain("const three = flagB")
  })

  it("skips effectful constant rewrites when preservation is disabled", () => {
    const result = run("if (check() || true) run(); else stop();", [], { simplifyEffectfulConditions: false })
    expect(result.code).toContain("check() || true")
    expect(result.report.warnings).toHaveLength(1)
  })
})

describe("control flow", () => {
  it("preserves lexical block scope when de-scoping is disabled", () => {
    const result = run("if (true) { const value = createValue(); consume(value) }", [], { flattenBlocks: false })
    expect(result.code).toBe("{ const value = createValue(); consume(value) }\n")
  })

  it("preserves effect order while collapsing a condition", () => {
    const result = run("if (check() || true) { run() } else { stop() }")
    expect(result.code).toBe("check();\nrun();\n")
    expect(result.report.effectsPreserved).toBeGreaterThan(0)
  })

  it("collapses nested branches to a fixed point", () => {
    expect(run("if (true) { if (false) oldPath(); else newPath() }").code).toBe("newPath();\n")
  })

  it("removes code after return and throw", () => {
    const returned = run("function f() { if (true) return result; fallback() }")
    const thrown = run("function f() { if (true) throw error; recover() }")
    expect(returned.code).toBe("function f() {\n  return result;\n}\n")
    expect(thrown.code).toBe("function f() {\n  throw error;\n}\n")
    expect(returned.report.unreachableStatementsRemoved).toBe(1)
  })

  it("folds ternaries while retaining effectful tests", () => {
    expect(run("const result = (check(), true) ? newValue : oldValue").code).toBe(
      "const result = (check(), newValue)\n",
    )
  })

  it("simplifies selected loops conservatively", () => {
    expect(run("while (false) legacyWork(); continueWork()").code).toBe("continueWork()\n")
    expect(run("while ((check(), false)) legacyWork()").code).toBe("check();\n")
    expect(run("for (initialize(); false; update()) work()").code).toBe("initialize();\n")
    expect(run("do { work() } while (false)").code).toBe("work();\n")
    expect(run("while (true) processNext()").code).toContain("while (true)")
  })
})

describe("block de-scoping", () => {
  const flags = [{ identifier: "FLAG", value: true }]

  it("hoists declarations from a safe block by default", () => {
    const source = `function f() {
  let user
  if (FLAG) {
    const access = load()
    user = use(access)
  }
  return user
}`
    const result = run(source, flags)
    expect(result.code).toContain("  const access = load()")
    expect(result.code).not.toMatch(/\{\s*const access/)
    expect(result.report.blocksFlattened).toBe(1)
  })

  it("preserves the scoping block when de-scoping is disabled", () => {
    const source = `function f() {
  let user
  if (FLAG) {
    const access = load()
    user = use(access)
  }
  return user
}`
    const result = run(source, flags, { flattenBlocks: false })
    expect(result.code).toMatch(/\{\s*const access = load\(\)/)
    expect(result.report.blocksFlattened).toBe(0)
  })

  it("emits valid output when hoisting statements without semicolons", () => {
    const source = "function f() {\n  let u\n  if (FLAG) {\n    const a = load()\n    u = use(a)\n  }\n  return u\n}\n"
    const result = run(source, flags)
    expect(result.report.blocksFlattened).toBe(1)
    expect(result.code).toContain("u = use(a);")
    expect(() => run(result.code, flags)).not.toThrow()
  })

  it("does not flatten when a declared name collides with an outer binding", () => {
    const source = `function f() {
  const access = outer()
  if (FLAG) {
    const access = inner()
    use(access)
  }
  return access
}`
    const result = run(source, flags)
    expect(result.report.blocksFlattened).toBe(0)
    expect(result.code).toMatch(/\{\s*const access = inner\(\)/)
  })

  it("does not flatten when a declared name is referenced outside the block", () => {
    const source = `function g() {
  if (FLAG) {
    const token = make()
    use(token)
  }
  log(token)
}`
    const result = run(source, flags)
    expect(result.report.blocksFlattened).toBe(0)
  })

  it("keeps the second sibling block when hoisting would redeclare a name", () => {
    const source = "if (FLAG) { const x = 1; }\nif (FLAG) { const x = 2; }\n"
    const result = run(source, flags)
    expect(result.report.blocksFlattened).toBe(1)
    expect(result.code).toContain("const x = 1;")
    expect(result.code).toMatch(/\{\s*const x = 2;?\s*\}/)
    expect(() => run(result.code, flags)).not.toThrow()
  })

  it("keeps comments while flattening", () => {
    const source = `if (FLAG) {
  // set up access
  const access = load()
  run(access)
}`
    const result = run(source, flags)
    expect(result.code).toContain("// set up access")
    expect(result.code).toContain("const access = load()")
    expect(result.report.blocksFlattened).toBe(1)
  })

  it("is idempotent after de-scoping", () => {
    const source = `function f() {
  let value
  if (FLAG) {
    const helper = build()
    value = helper.result
  }
  return value
}`
    const once = run(source, flags).code
    const twice = run(once, flags).code
    expect(twice).toBe(once)
  })
})

describe("comments, JSX, and output validity", () => {
  it("retains surviving comments and reports removed branch comments", () => {
    const source = `if (false) {
  // temporary fallback
  legacyPath()
} else {
  // required audit behavior
  currentPath()
}`
    const result = run(source)
    expect(result.code).toContain("required audit behavior")
    expect(result.code).not.toContain("temporary fallback")
    expect(result.report.removedComments).toContainEqual(
      expect.objectContaining({ value: "temporary fallback", retained: false }),
    )
  })

  it("retains protected dead comments", () => {
    const result = run("if (false) { /* TODO remove migration */ oldPath() }")
    expect(result.code).toContain("TODO remove migration")
    expect(result.report.removedComments[0]).toEqual(
      expect.objectContaining({ value: "TODO remove migration", retained: true }),
    )
  })

  it("retains license markers but not incidental copyright prose", () => {
    const license = run("if (false) { /* SPDX-License-Identifier: MIT */ old() }")
    expect(license.code).toContain("SPDX-License-Identifier")
    const author = run("if (false) { /* @author Jane */ old() }")
    expect(author.code).toContain("@author")
    const notice = run("if (false) { /* Copyright (c) 2026 Acme */ old() }")
    expect(notice.code).toContain("Copyright")
    const prose = run("if (false) { /* no copyright concerns here */ old() }")
    expect(prose.code).not.toContain("copyright concerns")
    expect(prose.report.removedComments[0]).toEqual(
      expect.objectContaining({ value: "no copyright concerns here", retained: false }),
    )
  })

  it("simplifies JSX children and boolean attributes", () => {
    expect(run("const view = <>{true && <NewPanel />}</>").code).toContain("<NewPanel />")
    expect(run("const view = <>{false && <LegacyPanel />}</>").code).toBe("const view = <></>\n")
    expect(run("const view = <Panel enabled={true} />").code).toBe("const view = <Panel enabled />\n")
    const effectful = "const view = <>{load() || true}</>"
    expect(run(effectful)).toMatchObject({ code: effectful, changed: false })
  })

  it("parses modern TSX and emits parseable output", () => {
    const source = `type Props = { enabled: boolean }
export function Panel({ enabled }: Props) {
  return <>{enabled ? <span>yes</span> : <span>no</span>}</>
}`
    expect(() => run(source)).not.toThrow()
  })

  it("roundtrips TypeScript template literal types", () => {
    const source = `type Route = \`/\${string}\`
const path: Route = "/home"
if (FLAG) go(path); else stay()`
    const result = run(source, [{ identifier: "FLAG", value: true }])
    expect(result.code).toContain("type Route = `/${string}`")
    expect(result.code).toContain("go(path);")
    expect(result.code).not.toContain("stay()")
  })
})

describe("determinism and runtime equivalence", () => {
  it("is idempotent for representative transforms", () => {
    const fixtures = [
      "if (FLAG) yes(); else no();",
      "const value = check() || FLAG",
      "while (FLAG) oldPath()",
      "const view = <>{FLAG && <Panel />}</>",
    ]
    for (const source of fixtures) {
      const once = run(source, [{ identifier: "FLAG", value: false }]).code
      const twice = run(once, [{ identifier: "FLAG", value: false }]).code
      expect(twice).toBe(once)
    }
  })

  it("preserves observable call order", () => {
    const source = `(() => {
      const events = []
      function check() { events.push("check"); return false }
      if (check() || FLAG) events.push("branch")
      return events
    })()`
    const output = run(source, [{ identifier: "FLAG", value: true }]).code
    const execute = (code: string) => Function("FLAG", `return (${code.trim().replace(/;$/, "")})`)(true)
    expect(execute(output)).toEqual(execute(source))
    expect(execute(output)).toEqual(["check", "branch"])
  })
})

describe("configuration", () => {
  it("rejects ambiguous and dynamic definitions", () => {
    expect(() => validateConfig({ flags: [{ value: true }] })).toThrow(/needs one of/)
    expect(() =>
      validateConfig({ flags: [{ identifier: "FLAG", call: "enabled", value: true }] }),
    ).toThrow(/cannot combine/)
    expect(() => validateConfig({ flags: [{ call: "client[method]", value: true }] })).toThrow(/static dotted/)
  })

  it("rejects unknown config, flag, and verify keys", () => {
    expect(() => validateConfig({ flags: [], preserveEffects: true })).toThrow(/unknown config key "preserveEffects"/)
    expect(() => validateConfig({ flags: [{ identifier: "FLAG", enabled: true }] })).toThrow(
      /unknown key "enabled"/,
    )
    expect(() => validateConfig({ flags: [], verify: { typo: true } })).toThrow(/verify has unknown key "typo"/)
  })

  it("defaults an omitted replacement value to true", () => {
    const config = validateConfig({ flags: [{ call: "useFlag", arguments: ["new-ui"] }] })
    expect(config.flags[0]?.value).toBe(true)
    expect(run('if (useFlag("new-ui")) yes(); else no();', config.flags).code).toBe("yes();\n")
  })

  it("accepts nested object and array values but rejects non-JSON leaves", () => {
    const config = validateConfig({
      flags: [{ call: "getVariant", arguments: ["x"], value: { enabled: true, weights: [1, 2], name: null } }],
    })
    expect(config.flags[0]?.value).toEqual({ enabled: true, weights: [1, 2], name: null })
    expect(() =>
      validateConfig({ flags: [{ identifier: "FLAG", value: { fn: (() => 1) as unknown as boolean } }] }),
    ).toThrow(/value\.fn must be a string, number, boolean, null, array, or object/)
    expect(() =>
      validateConfig({ flags: [{ identifier: "FLAG", value: [Number.NaN] }] }),
    ).toThrow(/value\[0\] must be a finite number/)
  })
})
