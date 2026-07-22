import { spawn } from "node:child_process"
import { constants as fsConstants, realpathSync, writeSync } from "node:fs"
import { access, chmod, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseExpression } from "@babel/parser"
import * as t from "@babel/types"
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
  ignore: string[]
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

const HELP = `Usage: flag-prune [options] <file-or-directory...>

Safely replace configured feature flags and remove dead code.

Quick start:
  npx flag-prune --flag hasFeature.newAccess src
  npx flag-prune --flag 'useFlag("new-access")=false' --write src

Options:
  -f, --flag <rule>    Flag rule; repeatable; value defaults to true
                        (NAME.path[=true|false] or 'CALL("key")[=true|false]')
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

function parseStaticArguments(source: string, rule: string): NonNullable<FlagDefinition["arguments"]> {
  let expression: t.Expression
  try {
    expression = parseExpression(`[${source}]`)
  } catch {
    throw new Error(`invalid --flag call: ${rule}; arguments must be static JSON primitives`)
  }
  if (!t.isArrayExpression(expression)) throw new Error(`invalid --flag call: ${rule}`)
  return expression.elements.map((element) => {
    if (t.isStringLiteral(element) || t.isNumericLiteral(element) || t.isBooleanLiteral(element)) {
      return element.value
    }
    if (
      t.isUnaryExpression(element, { operator: "-" }) &&
      t.isNumericLiteral(element.argument)
    ) {
      return -element.argument.value
    }
    if (t.isNullLiteral(element)) return null
    throw new Error(`invalid --flag call: ${rule}; arguments must be static JSON primitives`)
  })
}

function parseDirectCall(
  access: string,
  moduleName: string | undefined,
  value: boolean,
  rule: string,
): FlagDefinition | undefined {
  const opening = access.indexOf("(")
  if (opening < 0) return undefined
  if (!access.endsWith(")") || access.indexOf("(", opening + 1) >= 0) {
    throw new Error(`invalid --flag call: ${rule}`)
  }
  const call = access.slice(0, opening)
  if (!/^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/.test(call)) {
    throw new Error(`invalid --flag call: ${rule}; expected CALL("key")=true`)
  }
  return {
    ...(moduleName === undefined ? {} : { module: moduleName }),
    call,
    arguments: parseStaticArguments(access.slice(opening + 1, -1), rule),
    value,
  }
}

function parseDirectFlag(rule: string): FlagDefinition {
  const falseSuffix = "=false"
  const trueSuffix = "=true"
  const hasFalseSuffix = rule.endsWith(falseSuffix)
  const hasTrueSuffix = rule.endsWith(trueSuffix)
  const suffixLength = hasFalseSuffix ? falseSuffix.length : hasTrueSuffix ? trueSuffix.length : 0
  const rawSelector = suffixLength === 0 ? rule : rule.slice(0, -suffixLength)
  const flagValue = !hasFalseSuffix
  if (rawSelector.length === 0) {
    throw new Error(`invalid --flag rule: ${rule}; expected NAME.path or CALL("key")`)
  }

  const opening = rawSelector.indexOf("(")
  const possibleModuleSeparator = rawSelector.indexOf("#")
  const moduleSeparator =
    possibleModuleSeparator >= 0 && (opening < 0 || possibleModuleSeparator < opening)
      ? possibleModuleSeparator
      : -1
  const moduleName = moduleSeparator < 0 ? undefined : rawSelector.slice(0, moduleSeparator)
  const rawAccess = moduleSeparator < 0 ? rawSelector : rawSelector.slice(moduleSeparator + 1)
  if (moduleName === "") throw new Error(`invalid --flag selector: ${rawSelector}`)
  const directCall = parseDirectCall(rawAccess, moduleName, flagValue, rule)
  if (directCall !== undefined) return directCall
  const optional = rawAccess.includes("?.")
  const access = rawAccess.replaceAll("?.", ".")
  const parts = access.split(".")
  if (
    parts.length === 0 ||
    parts.some((part) => !/^[$A-Z_a-z][$\w]*$/.test(part))
  ) {
    throw new Error(`invalid --flag selector: ${rawSelector}`)
  }

  const [root, ...path] = parts as [string, ...string[]]
  const shared = {
    ...(path.length === 0 ? {} : { path }),
    ...(optional ? { optional: true } : {}),
    value: flagValue,
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
    ignore: [],
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
    else if (argument === "--ignore") {
      result.ignore.push(requireValue(args, index, argument))
      index += 1
    } else if (argument.startsWith("--ignore=")) {
      result.ignore.push(argument.slice("--ignore=".length))
    } else if (argument === "--typecheck") result.verification.typecheck = true
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

function isDeclarationFile(path: string): boolean {
  return /\.d\.[cm]?ts$/i.test(path)
}

interface DiscoveryOptions {
  ignored: Set<string>
  warnings: string[]
}

async function collectPath(path: string, files: Set<string>, options: DiscoveryOptions): Promise<void> {
  const info = await stat(path)
  if (info.isFile()) {
    if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) && !isDeclarationFile(path)) files.add(path)
    return
  }
  if (!info.isDirectory()) return
  const entries = await readdir(path, { withFileTypes: true })
  entries.sort((left, right) => comparePaths(left.name, right.name))
  for (const entry of entries) {
    const childPath = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      options.warnings.push(`skipped symlink ${childPath}`)
      continue
    }
    if (entry.isDirectory() && options.ignored.has(entry.name)) continue
    await collectPath(childPath, files, options)
  }
}

async function collectFiles(
  cwd: string,
  targets: string[],
  ignore: string[],
): Promise<{ files: string[]; warnings: string[] }> {
  const files = new Set<string>()
  const options: DiscoveryOptions = {
    ignored: new Set([...IGNORED_DIRECTORIES, ...ignore]),
    warnings: [],
  }
  for (const target of targets) await collectPath(resolve(cwd, target), files, options)
  return { files: [...files].sort(comparePaths), warnings: options.warnings }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const info = await stat(path)
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.flag-prune`)
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
  } else {
    const defaultPath = resolve(cwd, "flag-prune.config.json")
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
    throw new Error("no flags configured; use --flag NAME.path[=true|false] or --config <path>")
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
    const { files, warnings: discoveryWarnings } = await collectFiles(io.cwd, parsed.targets, parsed.ignore)
    for (const warning of discoveryWarnings) io.stderr.write(`warning: ${warning}\n`)
    if (files.length === 0) {
      io.stderr.write("flag-prune: no JavaScript or TypeScript files found\n")
      return 0
    }

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
    io.stderr.write(`flag-prune: ${error instanceof Error ? error.message : String(error)}\n`)
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
