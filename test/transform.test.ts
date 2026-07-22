import { describe, expect, it } from "vitest"
import { transform, validateConfig, type TransformOptions } from "../src/index.js"

function run(source: string, flags: TransformOptions["flags"] = [], options: Partial<TransformOptions> = {}) {
  return transform(source, { flags, filename: "fixture.tsx", ...options })
}

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

  it("matches approved calls with exact static arguments", () => {
    const source = `import { featureEnabled } from "./flags"
if (featureEnabled("new-access")) yes(); else no()
if (featureEnabled(dynamicName)) dynamic()
`
    const result = run(source, [
      { module: "./flags", call: "featureEnabled", arguments: ["new-access"], value: true },
    ])
    expect(result.code).toContain("yes();")
    expect(result.code).toContain("featureEnabled(dynamicName)")
    expect(result.code).toContain('import { featureEnabled } from "./flags";')
    expect(result.report.flagsReplaced).toBe(1)
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

  it("requires explicit optional semantics", () => {
    const source = "if (hasFeature?.flag) yes();"
    const unmatched = run(source, [{ identifier: "hasFeature", path: ["flag"], value: true }])
    const matched = run(source, [
      { identifier: "hasFeature", path: ["flag"], optional: true, value: true },
    ])
    expect(unmatched.report.flagsReplaced).toBe(0)
    expect(unmatched.code).toContain("hasFeature?.flag")
    expect(matched.code).toBe("yes();\n")
  })
})

describe("expression safety", () => {
  it.each([
    ["const value = !!true", "const value = true;\n"],
    ["const value = !false", "const value = true;\n"],
    ["const value = !!!true", "const value = false;\n"],
    ["const value = true === false", "const value = false;\n"],
    ["const value = true !== false", "const value = true;\n"],
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
      "const a = true;\nconst b = false;\n",
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
    expect(result.code).toContain("const a = flag;")
    expect(result.code).toContain("const b = flag;")
    expect(result.code).toContain("const c = false;")
    expect(result.code).toContain("const d = true;")
  })

  it("uses bounded symbolic equivalence for pure propositional formulas", () => {
    const source = `declare const flagA: boolean
declare const flagB: boolean
const one = (flagA && flagB) || (flagA && !flagB)
const two = (flagA || flagB) && (flagA || !flagB)
const three = (flagA && !flagA) || flagB`
    const result = run(source)
    expect(result.code).toContain("const one = flagA;")
    expect(result.code).toContain("const two = flagA;")
    expect(result.code).toContain("const three = flagB;")
  })

  it("skips effectful constant rewrites when preservation is disabled", () => {
    const result = run("if (check() || true) run(); else stop();", [], { preserveEffects: false })
    expect(result.code).toContain("check() || true")
    expect(result.report.warnings).toHaveLength(1)
  })
})

describe("control flow", () => {
  it("preserves lexical block scope", () => {
    const result = run("if (true) { const value = createValue(); consume(value) }")
    expect(result.code).toBe("{\n  const value = createValue();\n  consume(value);\n}\n")
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
      "const result = (check(), newValue);\n",
    )
  })

  it("simplifies selected loops conservatively", () => {
    expect(run("while (false) legacyWork(); continueWork()").code).toBe("continueWork();\n")
    expect(run("while ((check(), false)) legacyWork()").code).toBe("check();\n")
    expect(run("for (initialize(); false; update()) work()").code).toBe("initialize();\n")
    expect(run("do { work() } while (false)").code).toBe("work();\n")
    expect(run("while (true) processNext()").code).toContain("while (true)")
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

  it("simplifies JSX children and boolean attributes", () => {
    expect(run("const view = <>{true && <NewPanel />}</>").code).toContain("<NewPanel />")
    expect(run("const view = <>{false && <LegacyPanel />}</>").code).toBe("const view = <></>;\n")
    expect(run("const view = <Panel enabled={true} />").code).toBe("const view = <Panel enabled />;\n")
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
  })
})
