import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PassThrough, Readable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../src/cli.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function invoke(
  args: string[],
  cwd = resolve("."),
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

async function invokeGuided(
  input: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ""
  let stderr = ""
  const code = await runCli([], {
    cwd,
    env: {},
    stdin: Readable.from([input]),
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  })
  return { code, stdout, stderr }
}

async function waitForOutput(readOutput: () => string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (readOutput().includes(text)) return
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
  }
  throw new Error(`Timed out waiting for CLI output: ${text}`)
}

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "flag-prune-cli-"))
  temporaryDirectories.push(cwd)
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

  it("guides a bare command through one question at a time", async () => {
    const cwd = await fixture()
    const stdin = new PassThrough()
    let stdout = ""
    let stderr = ""
    const result = runCli([], {
      cwd,
      env: {},
      stdin,
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    })

    await waitForOutput(() => stdout, "What flag would you like to remove?")
    expect(stdout).toContain("npx flag-prune --help")
    expect(stdout).not.toContain("What value should replace this flag?")
    stdin.write("FLAG\n")

    await waitForOutput(() => stdout, "What value should replace this flag?")
    expect(stdout).not.toContain("Where should flag-prune look?")
    stdin.write("\n")

    await waitForOutput(() => stdout, "Where should flag-prune look?")
    stdin.write("\n")

    await waitForOutput(() => stdout, "Write these changes? [y/N]:")
    expect(stdout.indexOf("Write these changes?")).toBeGreaterThan(stdout.indexOf("1 flag replaced"))
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain("if (FLAG)")
    stdin.end("\n")

    expect(await result).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("--- a/input.ts\tbefore")
    expect(stdout).toContain("1 flag replaced")
    expect(stdout).toContain("After writing these changes, run your project's typecheck, lint, and tests.")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain("if (FLAG)")
  })

  it("writes a guided preview only after confirmation", async () => {
    const cwd = await fixture()
    const result = await invokeGuided("FLAG\n\ninput.ts\ny\n", cwd)

    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(result.stdout).toContain("Write these changes? [y/N]:")
    expect(result.stdout).toContain("Changes written to 1 file.")
    expect(result.stdout).toContain("Next: run your project's typecheck, lint, and tests.")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("does not start guided setup when CI=true", async () => {
    const cwd = await fixture()
    let stdout = ""
    let stderr = ""
    const code = await runCli([], {
      cwd,
      env: { CI: "true" },
      stdin: Readable.from([]),
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    })

    expect(code).toBe(2)
    expect(stdout).not.toContain("What flag would you like to remove?")
    expect(stdout).not.toContain("Write these changes?")
    expect(stderr).toContain("no arguments provided in CI environment")
  })

  it("accepts text and number values in guided setup", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      'if (readTier() === "pro" && limits.maxSeats === 25) yes(); else no();\n',
    )

    const text = await invokeGuided("readTier()\npro\ninput.ts\n\n", cwd)
    const number = await invokeGuided("limits.maxSeats\n25\ninput.ts\n\n", cwd)

    expect(text).toMatchObject({ code: 0, stderr: "" })
    expect(text.stdout).toContain("readTier()")
    expect(text.stdout).toContain("+if (limits.maxSeats === 25) yes(); else no();")
    expect(number).toMatchObject({ code: 0, stderr: "" })
    expect(number.stdout).toContain('+if (readTier() === "pro") yes(); else no();')
  })

  it("prints a dry-run diff without changing files", async () => {
    const cwd = await fixture()
    const result = await invoke(["--set", "FLAG", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("--- a/input.ts\tbefore")
    expect(result.stdout).toContain("1 flag replaced")
    expect(result.stdout).toContain("After writing these changes, run your project's typecheck, lint, and tests.")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain("if (FLAG)")
  })

  it("writes atomically and becomes a no-op on the second run", async () => {
    const cwd = await fixture()
    const first = await invoke(["--set", "FLAG", "--write", "--no-diff", "input.ts"], cwd)
    const second = await invoke(["--set", "FLAG", "--write", "--no-diff", "input.ts"], cwd)
    expect(first.code).toBe(0)
    expect(first.stdout).toContain("1 file changed")
    expect(first.stdout).toContain("Next: run your project's typecheck, lint, and tests.")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
    expect(second.stdout).toContain("0 files changed")
  })

  it("supports CI check and JSON reports", async () => {
    const cwd = await fixture()
    const result = await invoke(["--set", "FLAG", "--check", "--json", "input.ts"], cwd)
    expect(result.code).toBe(1)
    const output = JSON.parse(result.stdout) as { report: { filesChanged: number; flagsReplaced: number } }
    expect(output.report).toMatchObject({ filesChanged: 1, flagsReplaced: 1 })
  })

  it("returns usage status for invalid arguments", async () => {
    const result = await invoke(["--wat"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("unknown option: --wat")
  })

  it("runs for a direct member flag", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      "if (hasFeature.newAccess) yes(); else no();\n",
    )
    const result = await invoke(["--set", "hasFeature.newAccess=true", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("--- a/input.ts")
    expect(result.stderr).toBe("")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("replaces a process.env flag", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      "if (process.env.FEATURE_FLAG) yes(); else no();\n",
    )
    const preview = await invoke(
      ["--set", "process.env.FEATURE_FLAG=true", "input.ts"],
      cwd,
    )
    expect(preview).toMatchObject({ code: 0, stderr: "" })
    expect(preview.stdout).toContain("1 flag replaced")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain("process.env.FEATURE_FLAG")

    const result = await invoke(
      ["--set", "process.env.FEATURE_FLAG=true", "--write", "input.ts"],
      cwd,
    )
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("accepts an exact call rule and removes an assigned flag binding", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      'const x = useFlag("new-ui")\nif (x) yes(); else no();\n',
    )
    const result = await invoke(["--set", 'useFlag("new-ui")=false', "--write", "input.ts"], cwd)
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("no();\n")
  })

  it("defaults an omitted value to true and accepts trailing caller arguments", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      'function render(context: object) { const x = useFlag("new-ui", context); if (x) yes(); else no() }\n',
    )
    const result = await invoke(["--set", 'useFlag("new-ui")', "--write", "input.ts"], cwd)
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe(
      "function render(context: object) {\n  yes();\n}\n",
    )
  })

  it("defaults an omitted member value to true", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), "if (hasFeature.newUi) yes(); else no();\n")
    const result = await invoke(["--set", "hasFeature.newUi", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("accepts dotted call rules with static primitive arguments", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), 'if (flags.enabled("new-ui", -1, null)) yes(); else no();\n')
    const result = await invoke([
      "--set",
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
      "--set",
      'useFlag("release#1?.ready")=false',
      "--write",
      "input.ts",
    ], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("no();\n")
  })

  it("rejects dynamic call arguments", async () => {
    const result = await invoke(["--set", "useFlag(key)=true", "input.ts"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("arguments must be static JSON primitives")
  })

  it("supports an import-backed direct flag selector", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), 'import { FLAG } from "./flags"; if (FLAG) yes(); else no();\n')
    const result = await invoke(["--set", "./flags#FLAG=false", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe('import "./flags";\nno();\n')
  })

  it("can remove a proven side-effect-free flag import", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), 'import { FLAG } from "./flags"; if (FLAG) yes(); else no();\n')
    const result = await invoke(
      ["--set", "./flags#FLAG=true", "--remove-side-effect-imports", "--write", "input.ts"],
      cwd,
    )
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("supports equals syntax and repeated direct flags", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), "if (A && B) yes(); else no();\n")
    const result = await invoke(["--set=A=true", "--set=B=false", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("no();\n")
    expect(result.stdout).toContain("2 flags replaced")
  })

  it("does not load flag-prune.config.json", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "flag-prune.config.json"),
      JSON.stringify({ flags: [{ identifier: "FLAG", value: true }] }),
    )
    const result = await invoke(["--write", "input.ts"], cwd)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("no flags provided")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain("if (FLAG)")
  })

  it("explains how to provide a missing flag", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "flag-prune-cli-"))
    temporaryDirectories.push(cwd)
    await writeFile(join(cwd, "input.ts"), "work()\n")
    const result = await invoke(["input.ts"], cwd)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("use --set NAME.path[=value]")
  })

  it("rejects removed config options", async () => {
    const cwd = await fixture()
    const long = await invoke(["--config", "flags.json", "input.ts"], cwd)
    const short = await invoke(["-c=flags.json", "input.ts"], cwd)
    expect(long.code).toBe(2)
    expect(long.stderr).toContain("unknown option: --config")
    expect(short.code).toBe(2)
    expect(short.stderr).toContain("unknown option: -c=flags.json")
  })

  it("rejects the removed --flag option", async () => {
    const cwd = await fixture()
    const result = await invoke(["--flag", "FLAG", "input.ts"], cwd)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("unknown option: --flag")
  })

  it("skips declaration files", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "types.d.ts"), "export declare const FLAG: boolean;\n")
    const result = await invoke(["--set", "FLAG", "--write", "types.d.ts"], cwd)
    expect(result).toMatchObject({ code: 0 })
    expect(result.stderr).toContain("no files found")
    expect(await readFile(join(cwd, "types.d.ts"), "utf8")).toBe("export declare const FLAG: boolean;\n")
  })

  it("treats an empty target set as a benign no-op", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "flag-prune-cli-"))
    temporaryDirectories.push(cwd)
    await writeFile(join(cwd, "notes.md"), "# not source\n")
    const result = await invoke(["--set", "FLAG", "notes.md"], cwd)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("no files found")
  })

  it("warns about and skips nested symlinks and honors --ignore", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), "if (FLAG) yes(); else no();\n")
    const { mkdir, symlink } = await import("node:fs/promises")
    await mkdir(join(cwd, "vendor"))
    await writeFile(join(cwd, "vendor", "input.ts"), "if (FLAG) yes(); else no();\n")
    await symlink(join(cwd, "input.ts"), join(cwd, "linked.ts"))
    const result = await invoke(["--set", "FLAG", "--ignore", "vendor", "--write", "."], cwd)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("skipped symlink")
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
    expect(await readFile(join(cwd, "vendor", "input.ts"), "utf8")).toBe("if (FLAG) yes(); else no();\n")
  })

  it("accepts the inline -s= form", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), "if (hasFeature.newUi) yes(); else no();\n")
    const result = await invoke(["-s=hasFeature.newUi=true", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("yes();\n")
  })

  it("rejects combining --write and --dry-run", async () => {
    const result = await invoke(["--set", "FLAG", "--write", "--dry-run", "input.ts"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("cannot combine --write and --dry-run")
  })

  it("exposes comment policy through the CLI", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), "if (FLAG) {\n  // keep me\n  yes();\n} else no();\n")
    const result = await invoke(["--set", "FLAG", "--keep-comments", "--write", "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain("// keep me")
  })

  it("validates --comment-policy and --max-passes values", async () => {
    const policy = await invoke(["--set", "FLAG", "--comment-policy", "bogus", "input.ts"])
    expect(policy.code).toBe(2)
    expect(policy.stderr).toContain("--comment-policy must be report, preserve, or discard")
    const passes = await invoke(["--set", "FLAG", "--max-passes", "0", "input.ts"])
    expect(passes.code).toBe(2)
    expect(passes.stderr).toContain("--max-passes must be a positive integer")
  })

  it("keeps unused imports with --no-remove-unused-imports", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), 'import { FLAG } from "./flags";\nif (FLAG) yes(); else no();\n')
    const result = await invoke(
      ["--set", "./flags#FLAG=true", "--no-remove-unused-imports", "--write", "input.ts"],
      cwd,
    )
    expect(result.code).toBe(0)
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toContain('import { FLAG } from "./flags"')
  })

  it("rejects removed external verification options", async () => {
    const cwd = await fixture()
    const option = await invoke(["--set", "FLAG", "--typecheck", "input.ts"], cwd)

    expect(option.code).toBe(2)
    expect(option.stderr).toContain("unknown option: --typecheck")
  })

  it("preserves a symlink target when writing through it", async () => {
    const cwd = await fixture()
    const { lstat, symlink } = await import("node:fs/promises")
    await writeFile(join(cwd, "real.ts"), "if (FLAG) yes(); else no();\n")
    await symlink(join(cwd, "real.ts"), join(cwd, "link.ts"))
    const result = await invoke(["--set", "FLAG", "--write", "--no-diff", "link.ts"], cwd)
    expect(result.code).toBe(0)
    expect((await lstat(join(cwd, "link.ts"))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(cwd, "real.ts"), "utf8")).toBe("yes();\n")
  })

  it("reports binding and unreachable-statement counters", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      'function f() {\n  const enabled = useFlag("x")\n  if (enabled) return early()\n  dead()\n}\n',
    )
    const result = await invoke(["--set", 'useFlag("x")=true', "input.ts"], cwd)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("1 binding removed")
    expect(result.stdout).toContain("1 unreachable statement removed")
  })

  it("fails under --strict when a warning is emitted", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "input.ts"), "if (FLAG) yes(); else no();\n")
    const { symlink } = await import("node:fs/promises")
    await symlink(join(cwd, "input.ts"), join(cwd, "linked.ts"))
    const result = await invoke(["--set", "FLAG", "--strict", "--no-diff", "."], cwd)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("skipped symlink")
  })

  it("accepts a string-valued flag rule", async () => {
    const cwd = await fixture()
    await writeFile(
      join(cwd, "input.ts"),
      'const tier = readTier()\nif (tier === "pro") pro(); else free();\n',
    )
    const result = await invoke(["--set", 'readTier()=pro', "--write", "input.ts"], cwd)
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(await readFile(join(cwd, "input.ts"), "utf8")).toBe("pro();\n")
  })

  it("skips an unparseable file and processes the rest", async () => {
    const cwd = await fixture()
    await writeFile(join(cwd, "good.ts"), "if (FLAG) yes(); else no();\n")
    await writeFile(join(cwd, "broken.ts"), "const x = {\n")
    const result = await invoke(["--set", "FLAG", "--write", "--no-diff", "."], cwd)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("skipped")
    expect(result.stderr).toContain("broken.ts")
    expect(await readFile(join(cwd, "good.ts"), "utf8")).toBe("yes();\n")
    expect(await readFile(join(cwd, "broken.ts"), "utf8")).toBe("const x = {\n")
    const strict = await invoke(["--set", "FLAG", "--no-diff", "."], cwd)
    expect(strict.code).toBe(0)
    const strictFail = await invoke(["--set", "FLAG", "--strict", "--no-diff", "."], cwd)
    expect(strictFail.code).toBe(2)
  })
})
