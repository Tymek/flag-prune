import { describe, expect, it } from "vitest"
import { transform, type FlagDefinition, type TransformOptions } from "../src/index.js"

const memberFlag: FlagDefinition = {
  identifier: "hasFeature",
  path: ["newAccessControl"],
  value: true,
}

function run(
  source: string,
  flags: TransformOptions["flags"] = [],
  options: Partial<TransformOptions> = {},
) {
  return transform(source, { flags, filename: "goal-fixture.tsx", ...options })
}

describe("goal: literal, logical, and iterative simplification", () => {
  it("covers all literal boolean operations", () => {
    const result = run(`const a = !!true
const b = !false
const c = !!!true
const d = true === false
const e = true !== false`)
    expect(result.code).toBe(`const a = true
const b = true
const c = false
const d = false
const e = true
`)
  })

  it("folds numeric and string constant comparisons", () => {
    const result = run(`const a = 1 < 2
const b = 3 === 3
const c = "x" === "y"
const d = "beta" !== "alpha"
const e = 2 >= 5`)
    expect(result.code).toBe(`const a = true
const b = true
const c = false
const d = true
const e = false
`)
  })

  it("covers logical constants on both sides", () => {
    const result = run(`declare const flag: boolean
declare const value: unknown
const a = flag || true
const b = flag && false
const c = true && value
const d = false || value
const e = false && value
const f = true || value`)
    expect(result.code).toContain("const a = true")
    expect(result.code).toContain("const b = false")
    expect(result.code).toContain("const c = value")
    expect(result.code).toContain("const d = value")
    expect(result.code).toContain("const e = false")
    expect(result.code).toContain("const f = true")
  })

  it("folds nested expressions to a fixed point", () => {
    const result = run("const result = !(!false || (flag && true))", [
      { identifier: "flag", value: false },
    ])
    expect(result.code).toBe("const result = false\n")
    expect(result.report.passes).toBeGreaterThan(1)
  })

  it("narrows a conditional value to a numeric literal at a fixed point", () => {
    const result = run("const result = !(!A || (B && true)) ? 3 : 2", [
      { identifier: "A", value: false },
      { identifier: "B", value: false },
    ])
    expect(result.code).toBe("const result = 2\n")
    expect(result.report.passes).toBeGreaterThan(1)
  })

  it("eliminates newly dead branches at a fixed point", () => {
    const result = run(
      "if (A) three(); else if (!(!B || (C && true))) two(); else one();",
      [
        { identifier: "A", value: false },
        { identifier: "B", value: true },
        { identifier: "C", value: false },
      ],
    )
    expect(result.code).toBe("two();\n")
    expect(result.code).not.toContain("three")
    expect(result.code).not.toContain("one")
    expect(result.report.passes).toBeGreaterThan(1)
  })

  it("covers stable boolean identities, idempotence, and complements", () => {
    const result = run(`declare const x: boolean
const a = x && true
const b = x || false
const c = x && x
const d = x || x
const e = x && !x
const f = x || !x`)
    expect(result.code).toContain("const a = x")
    expect(result.code).toContain("const b = x")
    expect(result.code).toContain("const c = x")
    expect(result.code).toContain("const d = x")
    expect(result.code).toContain("const e = false")
    expect(result.code).toContain("const f = true")
  })

  it("preserves effectful evaluation in boolean and statement contexts", () => {
    expect(run("if (load() || true) run(); else stop();").code).toBe("load();\nrun();\n")
    expect(run("if (load() && false) run(); else stop();").code).toBe("load();\nstop();\n")
    expect(run("load() || true;").code).toBe("load();\n")
    expect(run("load() && false;").code).toBe("load();\n")
  })

  it("does not change unknown logical values in value context", () => {
    for (const source of ["const value = load() || true", "const value = load() && false"]) {
      expect(run(source)).toMatchObject({ code: source, changed: false })
    }
  })
})

describe("goal: control flow", () => {
  it.each([
    ["if (true) { newPath() } else { oldPath() }", "newPath();\n"],
    ["if (false) { oldPath() } else { newPath() }", "newPath();\n"],
    ["if (false) oldPath(); continueWork()", "continueWork()\n"],
    ["if (true || check()) run(); else stop();", "run();\n"],
    ["if (true) { if (false) oldPath(); else newPath() }", "newPath();\n"],
    ["if (false) first(); else if (true) second(); else third();", "second();\n"],
  ])("collapses %s", (source, expected) => {
    expect(run(source).code).toBe(expected)
  })

  it("keeps lexical branch scope", () => {
    expect(run("if (true) { const value = createValue(); consume(value) }").code).toMatch(/^\{[\s\n]/)
  })

  it("propagates return and throw and removes following code", () => {
    expect(run("function f() { if (true) return result; fallback() }").code).not.toContain("fallback")
    expect(run("function f() { if (true) throw error; recover() }").code).not.toContain("recover")
    expect(
      run("function f() { if (true) return result; else return fallback; neverRuns() }").code,
    ).not.toContain("neverRuns")
  })

  it("folds plain and effectful ternaries", () => {
    expect(run('const mode = true ? "new" : "old"').code).toBe('const mode = "new"\n')
    expect(run("const result = (check(), true) ? newValue : oldValue").code).toBe(
      "const result = (check(), newValue)\n",
    )
  })
})

describe("goal: JSX and loops", () => {
  it("covers JSX logical, ternary, attribute, and effectful-value behavior", () => {
    expect(run("const view = <>{true && <NewPanel />}</>").code).toContain("<NewPanel />")
    expect(run("const view = <>{false && <LegacyPanel />}</>").code).toBe("const view = <></>\n")
    expect(
      run("const view = <>{flag ? <NewPanel /> : <LegacyPanel />}</>", [
        { identifier: "flag", value: true },
      ]).code,
    ).toContain("<NewPanel />")
    expect(run("declare const flag: boolean; const view = <Panel enabled={flag || true} />").code).toContain(
      "<Panel enabled />",
    )
    const effectful = "const view = <>{load() || true}</>"
    expect(run(effectful)).toMatchObject({ code: effectful, changed: false })
  })

  it("covers dead, effectful, infinite, for, and do-while loops", () => {
    expect(run("while (false) legacyWork()").code).toBe("")
    expect(run("while ((check(), false)) legacyWork()").code).toBe("check();\n")
    expect(run("while (true) processNext()")).toMatchObject({ changed: false })
    expect(run("for (initialize(); false; update()) work()").code).toBe("initialize();\n")
    expect(run("do { work() } while (false)").code).toBe("work();\n")
  })

  it("retains lexical for-initializer scope and condition order", () => {
    const result = run("for (let item = initialize(); (check(), false); update()) work()")
    expect(result.code).toBe("{\n  let item = initialize()\n  check();\n}\n")
  })

  it("does not rewrite do-while loops containing loop control", () => {
    const source = "do { if (ready) break; work() } while (false)"
    expect(run(source)).toMatchObject({ code: source, changed: false })
  })
})

describe("goal: conservative must-not-transform cases", () => {
  it.each([
    "const result = enabled() || true",
    "const result = object.enabled || true",
    "const result = proxy.enabled && false",
    "const result = mightThrow() || true",
    "const result = (state.enabled = readFlag()) || true",
    "async function run() { return (await enabled()) || true }",
    "function* run() { return (yield enabled) || true }",
    "const result = value && true",
    "const result = Number.NaN || true",
    "const result = Boolean(1)",
  ])("leaves %s byte-identical", (source) => {
    expect(run(source)).toMatchObject({ code: source, changed: false })
  })

  it("does not trust shadowable globals", () => {
    const source = "function run(Number: CustomNumber) { return Number.NaN || true }"
    expect(run(source)).toMatchObject({ code: source, changed: false })
  })

  it("preserves a configured local initializer effect after removing its binding", () => {
    const result = run("const FLAG = readFlag(); if (FLAG) yes(); else no();", [
      { identifier: "FLAG", value: true },
    ])
    expect(result.code).toBe("readFlag();\nyes();\n")
    expect(result.report.bindingsRemoved).toBe(1)
  })

  it("keeps mutable configured declarations needed by later assignments", () => {
    const result = run("let FLAG = false; FLAG = readFlag(); if (FLAG) yes(); else no();", [
      { identifier: "FLAG", value: true },
    ])
    expect(result.code).toContain("let FLAG = false;")
    expect(result.code).toContain("FLAG = readFlag();")
    expect(result.code).toContain("yes();")
    expect(result.report.bindingsRemoved).toBe(0)
  })

  it("rewrites shorthand and computed value contexts to valid syntax", () => {
    const result = run("const object = { FLAG }; class Example { [FLAG]() {} }", [
      { identifier: "FLAG", value: true },
    ])
    expect(result.code).toContain("FLAG: true")
    expect(result.code).toContain("[true]()")
    expect(() => run(result.code)).not.toThrow()
  })

  it("does not replace a parameter inside its own shadowing default", () => {
    const source = "function run(FLAG = FLAG) { return FLAG }"
    expect(run(source, [{ identifier: "FLAG", value: true }])).toMatchObject({
      code: source,
      changed: false,
    })
  })
})

describe("goal: comments and imports", () => {
  const comments = `if (false) {
  // Remove after migration finishes.
  legacyPath()
} else {
  // Required audit behavior.
  currentPath()
}`

  it("retains live comments and reports dead comments", () => {
    const result = run(comments)
    expect(result.code).toContain("Required audit behavior.")
    expect(result.code).not.toContain("Remove after migration finishes.")
    expect(result.report.removedComments).toContainEqual(
      expect.objectContaining({ value: "Remove after migration finishes.", retained: false }),
    )
  })

  it("supports preserve and discard comment policies", () => {
    expect(run(comments, [], { commentPolicy: "preserve" }).code).toContain("Remove after migration finishes.")
    expect(run(comments, [], { commentPolicy: "discard" }).report.removedComments).toHaveLength(0)
  })

  it("preserves module initialization unless explicitly approved for removal", () => {
    const source = 'import { FLAG } from "./flags"; if (FLAG) yes();'
    const flags = [{ module: "./flags", export: "FLAG", value: true }]
    expect(run(source, flags).code).toContain('import "./flags";')
    expect(run(source, flags, { removeSideEffectImports: true }).code).not.toContain("import")
  })
})

describe("goal: idempotence and runtime differential checks", () => {
  const fixtures: Array<[string, TransformOptions["flags"]]> = [
    ["if (hasFeature.newAccessControl) yes(); else no();", [memberFlag]],
    ["if (check() || FLAG) branch();", [{ identifier: "FLAG", value: true }]],
    ["const view = <>{FLAG && <Panel />}</>", [{ identifier: "FLAG", value: false }]],
    ["for (initialize(); FLAG; update()) work()", [{ identifier: "FLAG", value: false }]],
  ]

  it.each(fixtures)("is idempotent for %s", (source, flags) => {
    const once = run(source, flags).code
    expect(run(once, flags).code).toBe(once)
  })

  it("matches event, getter, and mutation order", () => {
    const source = `(() => {
      const events = []
      const state = { enabled: false }
      const object = { get enabled() { events.push("get"); return false } }
      function read() { events.push("read"); return false }
      if (object.enabled || FLAG) events.push("getter-branch")
      if ((state.enabled = read()) || FLAG) events.push("mutation-branch")
      return { events, state }
    })()`
    const transformed = run(source, [{ identifier: "FLAG", value: true }]).code
    const execute = (code: string) => Function("FLAG", `return (${code.trim().replace(/;$/, "")})`)(true)
    expect(execute(transformed)).toEqual(execute(source))
    expect(execute(transformed)).toEqual({
      events: ["get", "getter-branch", "read", "mutation-branch"],
      state: { enabled: false },
    })
  })

  it("does not hide thrown errors", () => {
    const source = `(() => {
      function fail() { throw new Error("boom") }
      if (fail() || FLAG) return "unreachable"
    })()`
    const transformed = run(source, [{ identifier: "FLAG", value: true }]).code
    const execute = (code: string) => () => Function("FLAG", `return (${code.trim().replace(/;$/, "")})`)(true)
    expect(execute(source)).toThrow("boom")
    expect(execute(transformed)).toThrow("boom")
  })

  it("produces the same result one flag at a time or together", () => {
    const source = "if (A && B) yes(); else no();"
    const a = { identifier: "A", value: true } as const
    const b = { identifier: "B", value: false } as const
    const together = run(source, [a, b]).code
    const sequential = run(run(source, [a]).code, [b]).code
    expect(sequential).toBe(together)
    expect(together).toBe("no();\n")
  })
})