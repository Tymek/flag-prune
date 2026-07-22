import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function invoke(args: string[], cwd = resolve(".")): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("dist/cli.js"), ...args], { cwd })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.once("error", reject)
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }))
  })
}

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "flag-prune-cli-"))
  temporaryDirectories.push(cwd)
  await writeFile(
    join(cwd, "flags.json"),
    JSON.stringify({ flags: [{ identifier: "FLAG", value: true }] }),
  )
  await writeFile(join(cwd, "input.ts"), "if (FLAG) yes(); else no();\n")
  return cwd
}

describe("flag-prune process", () => {
  it("prints help and version", async () => {
    const help = await invoke(["--help"])
    const version = await invoke(["--version"])
    expect(help).toMatchObject({ code: 0, stderr: "" })
    expect(help.stdout).toContain("Usage: flag-prune")
    expect(version).toMatchObject({ code: 0, stdout: "1.0.0\n", stderr: "" })
  })

  it("prints a dry-run diff without changing files", async () => {
    const cwd = await fixture()
    const result = await invoke(["--config", "flags.json", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("--- a/input.ts\tbefore")
    expect(result.stdout).toContain("1 flag replaced")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain("if (FLAG)")
  })

  it("writes atomically and becomes a no-op on the second run", async () => {
    const cwd = await fixture()
    const first = await invoke(["--config", "flags.json", "--write", "--no-diff", "input.ts"], cwd)
    const second = await invoke(["--config", "flags.json", "--write", "--no-diff", "input.ts"], cwd)
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("1 file changed")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
    expect(second.stdout).toContain("0 files changed")
  })

  it("supports CI check and JSON reports", async () => {
    const cwd = await fixture()
    const result = await invoke(["--config", "flags.json", "--check", "--json", "input.ts"], cwd)
    expect(result.code).toBe(1)
    const output = JSON.parse(result.stdout) as { report: { filesChanged: number; flagsReplaced: number } }
    expect(output.report).toMatchObject({ filesChanged: 1, flagsReplaced: 1 })
  })

  it("returns usage status for invalid arguments", async () => {
    const result = await invoke(["--wat"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("unknown option: --wat")
  })

  it("runs without a config for a direct member flag", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      "if (hasFeature.newAccess) yes(); else no();\n",
    )
    const result = await invoke(["--flag", "hasFeature.newAccess=true", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("--- a/input.ts")
    expect(result.stderr).toBe("")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("accepts an exact call rule and removes an assigned flag binding", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      'const x = useFlag("new-ui")\nif (x) yes(); else no();\n',
    )
    const result = await invoke(["--flag", 'useFlag("new-ui")=false', "--write", "input.ts"], cwd)
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("no();\n")
  })

  it("defaults an omitted value to true and accepts trailing caller arguments", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      'function render(context: object) { const x = useFlag("new-ui", context); if (x) yes(); else no() }\n',
    )
    const result = await invoke(["--flag", 'useFlag("new-ui")', "--write", "input.ts"], cwd)
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe(
      "function render(context: object) {\n  yes();\n}\n",
    )
  })

  it("defaults an omitted member value to true", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), "if (hasFeature.newUi) yes(); else no();\n")
    const result = await invoke(["--flag", "hasFeature.newUi", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("accepts dotted call rules with static primitive arguments", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), 'if (flags.enabled("new-ui", -1, null)) yes(); else no();\n')
    const result = await invoke([
      "--flag",
      'flags.enabled("new-ui", -1, null)=true',
      "--write",
      "input.ts",
    ], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("keeps punctuation inside exact string keys", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), 'if (useFlag("release#1?.ready")) yes(); else no();\n')
    const result = await invoke([
      "--flag",
      'useFlag("release#1?.ready")=false',
      "--write",
      "input.ts",
    ], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("no();\n")
  })

  it("rejects dynamic call arguments", async () => {
    const result = await invoke(["--flag", "useFlag(key)=true", "input.ts"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("arguments must be static JSON primitives")
  })

  it("supports an import-backed direct flag selector", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), 'import { FLAG } from "./flags"; if (FLAG) yes(); else no();\n')
    const result = await invoke(["--flag", "./flags#FLAG=false", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe('import "./flags";\nno();\n')
  })

  it("can remove a proven side-effect-free flag import", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), 'import { FLAG } from "./flags"; if (FLAG) yes(); else no();\n')
    const result = await invoke(
      ["--flag", "./flags#FLAG=true", "--remove-side-effect-imports", "--write", "input.ts"],
      cwd,
    )
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("supports equals syntax and repeated direct flags", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), "if (A && B) yes(); else no();\n")
    const result = await invoke(["--flag=A=true", "--flag=B=false", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("no();\n")
    expect(result.stdout).toContain("2 flags replaced")
  })

  it("auto-loads flag-prune.config.json when direct flags are absent", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "flag-prune.config.json"), await readFile(join(cwd, "flags.json")))
    const result = await invoke(["--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("explains how to configure a missing flag", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "flag-prune-cli-"))
    temporaryDirectories.push(cwd)
    await writeFile(join(cwd, "input.ts"), "work()\n")
    const result = await invoke(["input.ts"], cwd)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("use --flag NAME.path[=true|false] or --config <path>")
  })
})
