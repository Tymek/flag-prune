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
  const cwd = await mkdtemp(join(tmpdir(), "flag-clean-cli-"))
  temporaryDirectories.push(cwd)
  await writeFile(
    join(cwd, "flags.json"),
    JSON.stringify({ flags: [{ identifier: "FLAG", value: true }] }),
  )
  await writeFile(join(cwd, "input.ts"), "if (FLAG) yes(); else no();\n")
  return cwd
}

describe("flag-clean process", () => {
  it("prints help and version", async () => {
    const help = await invoke(["--help"])
    const version = await invoke(["--version"])
    expect(help).toMatchObject({ code: 0, stderr: "" })
    expect(help.stdout).toContain("Usage: flag-clean")
    expect(version).toMatchObject({ code: 0, stdout: "1.0.0\n", stderr: "" })
  })

  it("prints a dry-run diff without changing files", async () => {
    const cwd = await fixture()
    const result = await invoke(["--config", "flags.json", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("--- a/input.ts\tbefore")
    expect(result.stdout).toContain("1 flags replaced")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain("if (FLAG)")
  })

  it("writes atomically and becomes a no-op on the second run", async () => {
    const cwd = await fixture()
    const first = await invoke(["--config", "flags.json", "--write", "--no-diff", "input.ts"], cwd)
    const second = await invoke(["--config", "flags.json", "--write", "--no-diff", "input.ts"], cwd)
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("1 files changed")
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
})
