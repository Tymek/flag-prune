import { spawn } from "node:child_process"
import { constants as fsConstants, realpathSync, writeSync } from "node:fs"
import { access, chmod, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createTwoFilesPatch } from "diff"
import { validateConfig } from "./config.js"
import { transform } from "./transform.js"
import type { FlagCleanConfig, FlagDefinition, TransformReport, VerificationConfig } from "./types.js"

const VERSION = "1.0.0"
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"])
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"])

interface CliArguments {
  configPath: string | undefined
  directFlags: FlagDefinition[]
  write: boolean
  check: boolean
  diff: boolean
  diffExplicit: boolean
  removeSideEffectImports: boolean
  json: boolean
  help: boolean
  version: boolean
  verification: { typecheck: boolean; lint: boolean; tests: boolean }
  targets: string[]
}

interface FileResult {
  path: string
  source: string
  code: string
  changed: boolean
  report: TransformReport
}

export interface CliIo {
  cwd: string
  stdout: { write(value: string): unknown }
  stderr: { write(value: string): unknown }
}

const HELP = `Usage: flag-clean [options] <file-or-directory...>

Safely replace configured feature flags and remove dead code.

Quick start:
  flag-clean --flag hasFeature.newAccess=true src
  flag-clean --flag ./flags#NEW_ACCESS=false --write src

Options:
  -f, --flag <rule>    Flag rule; repeatable (NAME.path=true or module#EXPORT=false)
  -c, --config <path>  JSON config (auto-detected when no --flag is given)
  -w, --write          Write changes atomically
      --check          Exit 1 when files would change
      --diff           Print unified diffs (default in dry-run mode)
      --no-diff        Hide unified diffs
      --json           Print machine-readable report
      --remove-side-effect-imports
                        Delete empty flag imports known to be side-effect-free
      --typecheck      Run configured/default typecheck after writing
      --lint           Run configured/default lint after writing
      --test           Run configured/default tests after writing
  -h, --help           Show help
  -v, --version        Show version
`

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("-")) throw new Error(`${option} requires a value`)
  return value
}

function parseDirectFlag(rule: string): FlagDefinition {
  const separator = rule.lastIndexOf("=")
  const rawSelector = separator < 0 ? "" : rule.slice(0, separator)
  const rawValue = separator < 0 ? "" : rule.slice(separator + 1)
  if (rawSelector.length === 0 || (rawValue !== "true" && rawValue !== "false")) {
    throw new Error(`invalid --flag rule: ${rule}; expected NAME.path=true or module#EXPORT=false`)
  }

  const optional = rawSelector.includes("?.")
  const selector = rawSelector.replaceAll("?.", ".")
  const moduleSeparator = selector.indexOf("#")
  const moduleName = moduleSeparator < 0 ? undefined : selector.slice(0, moduleSeparator)
  const access = moduleSeparator < 0 ? selector : selector.slice(moduleSeparator + 1)
  const parts = access.split(".")
  if (
    moduleName === "" ||
    parts.length === 0 ||
    parts.some((part) => !/^[$A-Z_a-z][$\w]*$/.test(part))
  ) {
    throw new Error(`invalid --flag selector: ${rawSelector}`)
  }

  const [root, ...path] = parts as [string, ...string[]]
  const shared = {
    ...(path.length === 0 ? {} : { path }),
    ...(optional ? { optional: true } : {}),
    value: rawValue === "true",
  }
  return moduleName === undefined
    ? { identifier: root, ...shared }
    : { module: moduleName, export: root, ...shared }
}

function parseArguments(args: string[]): CliArguments {
  const result: CliArguments = {
    configPath: undefined,
    directFlags: [],
    write: false,
    check: false,
    diff: true,
    diffExplicit: false,
    removeSideEffectImports: false,
    json: false,
    help: false,
    version: false,
    verification: { typecheck: false, lint: false, tests: false },
    targets: [],
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === "--") {
      result.targets.push(...args.slice(index + 1))
      break
    }
    if (argument === "-c" || argument === "--config") {
      result.configPath = requireValue(args, index, argument)
      index += 1
    } else if (argument === "-f" || argument === "--flag") {
      result.directFlags.push(parseDirectFlag(requireValue(args, index, argument)))
      index += 1
    } else if (argument.startsWith("--flag=")) {
      result.directFlags.push(parseDirectFlag(argument.slice("--flag=".length)))
    } else if (argument === "-w" || argument === "--write") result.write = true
    else if (argument === "--check") result.check = true
    else if (argument === "--diff") {
      result.diff = true
      result.diffExplicit = true
    } else if (argument === "--no-diff") {
      result.diff = false
      result.diffExplicit = true
    }
    else if (argument === "--json") result.json = true
    else if (argument === "--remove-side-effect-imports") result.removeSideEffectImports = true
    else if (argument === "--typecheck") result.verification.typecheck = true
    else if (argument === "--lint") result.verification.lint = true
    else if (argument === "--test") result.verification.tests = true
    else if (argument === "-h" || argument === "--help") result.help = true
    else if (argument === "-v" || argument === "--version") result.version = true
    else if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`)
    else result.targets.push(argument)
  }
  if (result.json) result.diff = false
  else if (result.write && !result.diffExplicit) result.diff = false
  return result
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function collectPath(path: string, files: Set<string>): Promise<void> {
  const info = await stat(path)
  if (info.isFile()) {
    if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) files.add(path)
    return
  }
  if (!info.isDirectory()) return
  const entries = await readdir(path, { withFileTypes: true })
  entries.sort((left, right) => comparePaths(left.name, right.name))
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue
    await collectPath(join(path, entry.name), files)
  }
}

async function collectFiles(cwd: string, targets: string[]): Promise<string[]> {
  const files = new Set<string>()
  for (const target of targets) await collectPath(resolve(cwd, target), files)
  return [...files].sort(comparePaths)
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const info = await stat(path)
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.flag-clean`)
  try {
    await writeFile(temporary, contents, { mode: info.mode })
    await chmod(temporary, info.mode)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function aggregateReports(results: FileResult[]): Omit<TransformReport, "filename"> & { filesChanged: number } {
  const report = {
    filesChanged: results.filter((result) => result.changed).length,
    flagsReplaced: 0,
    expressionsFolded: 0,
    deadBranchesRemoved: 0,
    unreachableStatementsRemoved: 0,
    importsRemoved: 0,
    bindingsRemoved: 0,
    effectsPreserved: 0,
    removedComments: [] as TransformReport["removedComments"],
    warnings: [] as string[],
    passes: 0,
  }
  for (const result of results) {
    report.flagsReplaced += result.report.flagsReplaced
    report.expressionsFolded += result.report.expressionsFolded
    report.deadBranchesRemoved += result.report.deadBranchesRemoved
    report.unreachableStatementsRemoved += result.report.unreachableStatementsRemoved
    report.importsRemoved += result.report.importsRemoved
    report.bindingsRemoved += result.report.bindingsRemoved
    report.effectsPreserved += result.report.effectsPreserved
    report.removedComments.push(...result.report.removedComments)
    report.warnings.push(...result.report.warnings.map((warning) => `${result.path}: ${warning}`))
    report.passes = Math.max(report.passes, result.report.passes)
  }
  return report
}

function humanSummary(report: ReturnType<typeof aggregateReports>): string {
  const count = (value: number, singular: string, plural = `${singular}s`) =>
    `${value} ${value === 1 ? singular : plural}`
  return [
    `${count(report.filesChanged, "file")} changed`,
    `${count(report.flagsReplaced, "flag")} replaced`,
    `${count(report.expressionsFolded, "expression")} folded`,
    `${count(report.deadBranchesRemoved, "dead branch", "dead branches")} removed`,
    `${count(report.importsRemoved, "import")} removed`,
    `${count(report.effectsPreserved, "effectful expression")} preserved`,
    `${count(report.removedComments.filter((comment) => !comment.retained).length, "comment")} removed and reported`,
    count(report.warnings.length, "warning"),
  ].join("\n")
}

async function loadConfig(parsed: CliArguments, cwd: string): Promise<FlagCleanConfig> {
  let configured: FlagCleanConfig = { flags: [] }
  if (parsed.configPath !== undefined) {
    const path = resolve(cwd, parsed.configPath)
    configured = validateConfig(JSON.parse(await readFile(path, "utf8")))
  } else if (parsed.directFlags.length === 0) {
    const defaultPath = resolve(cwd, "flag-clean.config.json")
    if (await pathExists(defaultPath)) {
      configured = validateConfig(JSON.parse(await readFile(defaultPath, "utf8")))
    }
  }

  const config = validateConfig({
    ...configured,
    ...(parsed.removeSideEffectImports ? { removeSideEffectImports: true } : {}),
    flags: [...parsed.directFlags, ...configured.flags],
  })
  if (config.flags.length === 0) {
    throw new Error("no flags configured; use --flag NAME.path=true or --config <path>")
  }
  return config
}

async function commandExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function packageScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    return packageJson.scripts ?? {}
  } catch {
    return {}
  }
}

async function defaultVerificationCommand(
  cwd: string,
  kind: "typecheck" | "lint" | "tests",
): Promise<string> {
  const scriptName = kind === "tests" ? "test" : kind
  const scripts = await packageScripts(cwd)
  if (scripts[scriptName] !== undefined) {
    const packageManager = await pathExists(join(cwd, "pnpm-lock.yaml")) ? "pnpm" : "npm"
    return `${packageManager} run ${scriptName}`
  }
  if (kind === "tests") throw new Error("test verification requested but package.json has no test script")
  const executable = join(cwd, "node_modules", ".bin", kind === "typecheck" ? "tsc" : "eslint")
  if (!(await commandExists(executable))) throw new Error(`${kind} verification requested but no command was found`)
  return kind === "typecheck" ? `"${executable}" --noEmit` : `"${executable}" .`
}

function spawnCommand(command: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit", env: process.env })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`verification command failed (${signal ?? `exit ${code ?? "unknown"}`}): ${command}`))
    })
  })
}

async function runVerification(
  cwd: string,
  configured: VerificationConfig | undefined,
  requested: CliArguments["verification"],
): Promise<void> {
  const checks = ["typecheck", "lint", "tests"] as const
  for (const check of checks) {
    const setting = requested[check] || configured?.[check]
    if (!setting) continue
    const command = typeof setting === "string" ? setting : await defaultVerificationCommand(cwd, check)
    await spawnCommand(command, cwd)
  }
}

export async function runCli(
  args: string[],
  io: CliIo = { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const parsed = parseArguments(args)
    if (parsed.help) {
      io.stdout.write(HELP)
      return 0
    }
    if (parsed.version) {
      io.stdout.write(`${VERSION}\n`)
      return 0
    }
    if (parsed.targets.length === 0) throw new Error("provide at least one file or directory")
    const config = await loadConfig(parsed, io.cwd)
    const files = await collectFiles(io.cwd, parsed.targets)
    if (files.length === 0) throw new Error("no JavaScript or TypeScript files found")

    const results: FileResult[] = []
    for (const path of files) {
      const source = await readFile(path, "utf8")
      const result = transform(source, { ...config, filename: relative(io.cwd, path) })
      results.push({ path, source, ...result })
    }
    const report = aggregateReports(results)

    if (parsed.write) {
      for (const result of results) if (result.changed) await atomicWrite(result.path, result.code)
    }
    if (parsed.diff) {
      for (const result of results) {
        if (!result.changed) continue
        const label = relative(io.cwd, result.path).replaceAll("\\", "/")
        io.stdout.write(createTwoFilesPatch(`a/${label}`, `b/${label}`, result.source, result.code, "before", "after"))
      }
    }
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify({ report, files: results.map(({ path, changed, report: fileReport }) => ({ path, changed, report: fileReport })) }, null, 2)}\n`)
    } else {
      io.stdout.write(`${humanSummary(report)}\n`)
      for (const warning of report.warnings) io.stderr.write(`warning: ${warning}\n`)
    }

    const verificationRequested =
      Object.values(parsed.verification).some(Boolean) ||
      Boolean(config.verify?.typecheck || config.verify?.lint || config.verify?.tests)
    if (verificationRequested && !parsed.write && report.filesChanged > 0) {
      throw new Error("verification of changed output requires --write")
    }
    await runVerification(io.cwd, config.verify, parsed.verification)
    return parsed.check && report.filesChanged > 0 ? 1 : 0
  } catch (error) {
    io.stderr.write(`flag-clean: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(resolve(fileURLToPath(import.meta.url)))
if (isEntryPoint) {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: { write: (value) => writeSync(1, value) },
    stderr: { write: (value) => writeSync(2, value) },
  })
}
