import { readFileSync, realpathSync, writeSync } from "node:fs"
import { chmod, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { parseExpression } from "@babel/parser"
import * as t from "@babel/types"
import { createTwoFilesPatch } from "diff"
import { validateConfig } from "./config.js"
import { transform } from "./transform.js"
import type { FlagCleanConfig, FlagDefinition, FlagValue, TransformReport } from "./types.js"

const VERSION = readVersion()
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"])
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"])

/** Read the package version from package.json next to the built entry point. */
function readVersion(): string {
  try {
    const contents = readFileSync(new URL("../package.json", import.meta.url), "utf8")
    const version = (JSON.parse(contents) as { version?: unknown }).version
    return typeof version === "string" ? version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

interface CliArguments {
  directFlags: FlagDefinition[]
  write: boolean
  check: boolean
  diff: boolean
  diffExplicit: boolean
  color: "auto" | "always" | "never"
  removeSideEffectImports: boolean
  json: boolean
  help: boolean
  version: boolean
  ignore: string[]
  strict: boolean
  overrides: Partial<FlagCleanConfig>
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
  env?: NodeJS.ProcessEnv
  stdin?: NodeJS.ReadableStream
  stdout: { write(value: string): unknown; isTTY?: boolean }
  stderr: { write(value: string): unknown }
}

const HELP = `Usage: flag-prune [options] <file-or-directory...>

Safely replace configured feature flags and remove dead code.

Quick start:
  npx flag-prune
  npx flag-prune --set hasFeature.newAccess src
  npx flag-prune --set 'useFlag("new-access")=false' --write src

  Run with no options to start a guided setup. After the preview, you can
  choose whether to write the changes. Guided setup is disabled when CI=true.

Flag rule syntax (repeat --set for multiple rules):
  NAME.path[=value]               local/global identifier or member access
  module#EXPORT.path[=value]      imported binding (aliases resolved)
  'CALL("key", 1)[=value]'        approved call; args are an exact prefix
  a?.b or CALL?.("k")             optional access matches the plain form too
  Value defaults to true; accepts booleans, numbers, null, and strings
  (e.g. =treatment, =3, =null, or a quoted "value with spaces").
  Use '--' to end options before file targets.

Options:
  -s, --set <rule>    Flag rule (also -s=RULE / --set=RULE)
  -w, --write          Write changes atomically
      --dry-run        Preview only; never write (default; conflicts with -w)
      --check          Exit 1 when files would change
      --strict         Exit 2 when any warning is emitted
      --diff           Print unified diffs (default in dry-run mode)
      --no-diff        Hide unified diffs (default with --write or --json)
      --color[=when]   Colorize diffs: auto (default), always, or never
      --no-color       Disable colored diff output
      --json           Print machine-readable report (disables the diff)
      --ignore <name>  Extra directory name to skip; repeatable
      --comment-policy <report|preserve|discard>
                        How to handle comments on removed code (default report)
      --keep-comments  Shortcut for --comment-policy preserve
      --no-remove-unused-imports
                        Keep imports even after their flag binding is removed
      --remove-side-effect-imports
                        Delete empty flag imports known to be side-effect-free
      --no-flatten-blocks
                        Keep scoping blocks left by folding instead of safely
                        de-scoping their declarations (de-scoping is the default)
      --skip-effectful-conditions
                        Leave constant conditions whose test still has effects
      --max-passes <n>  Cap simplification passes (default 20)
      --no-parse-check  Skip reparsing the generated output
  -h, --help           Show help
  -v, --version        Show version

Exit codes:
  0  success (no changes, or changes previewed/written)
  1  --check requested and files would change
  2  usage or processing error (also --strict with warnings, or non-convergence)
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
    throw new Error(`invalid --set call: ${rule}; arguments must be static JSON primitives`)
  }
  if (!t.isArrayExpression(expression)) throw new Error(`invalid --set call: ${rule}`)
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
    throw new Error(`invalid --set call: ${rule}; arguments must be static JSON primitives`)
  })
}

function parseValueToken(raw: string, rule: string): FlagValue {
  if (raw.length === 0) throw new Error(`invalid --set rule: ${rule}; expected a value after '='`)
  if (raw === "true") return true
  if (raw === "false") return false
  if (raw === "null") return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return Number(raw)
  if (raw.startsWith("{") || raw.startsWith("[")) {
    let expression: t.Expression
    try {
      expression = parseExpression(raw)
    } catch {
      throw new Error(`invalid --set value: ${rule}; malformed object or array literal`)
    }
    return expressionToFlagValue(expression, rule)
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string
    } catch {
      throw new Error(`invalid --set rule: ${rule}; malformed quoted value`)
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  return raw
}

/** Convert a static literal expression into a flag value, rejecting dynamic shapes. */
function expressionToFlagValue(node: t.Expression | t.PatternLike, rule: string): FlagValue {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value
  if (t.isNullLiteral(node)) return null
  if (t.isUnaryExpression(node, { operator: "-" }) && t.isNumericLiteral(node.argument)) {
    return -node.argument.value
  }
  if (t.isArrayExpression(node)) {
    return node.elements.map((element) => {
      if (element === null || t.isSpreadElement(element)) {
        throw new Error(`invalid --set value: ${rule}; array elements must be static literals`)
      }
      return expressionToFlagValue(element, rule)
    })
  }
  if (t.isObjectExpression(node)) {
    const result: { [key: string]: FlagValue } = {}
    for (const property of node.properties) {
      if (!t.isObjectProperty(property) || property.computed) {
        throw new Error(`invalid --set value: ${rule}; object properties must be static and unquoted or string keys`)
      }
      const key = t.isIdentifier(property.key)
        ? property.key.name
        : t.isStringLiteral(property.key)
          ? property.key.value
          : t.isNumericLiteral(property.key)
            ? String(property.key.value)
            : undefined
      if (key === undefined || !t.isExpression(property.value)) {
        throw new Error(`invalid --set value: ${rule}; object properties must be static literals`)
      }
      result[key] = expressionToFlagValue(property.value, rule)
    }
    return result
  }
  throw new Error(`invalid --set value: ${rule}; values must be static JSON literals`)
}

/** Split a flag rule into its selector and replacement value at the first top-level '='. */
function splitValue(rule: string): { selector: string; value: FlagValue } {
  let depth = 0
  let quote = ""
  for (let index = 0; index < rule.length; index += 1) {
    const character = rule[index]!
    if (quote !== "") {
      if (character === quote && rule[index - 1] !== "\\") quote = ""
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === "(" || character === "[" || character === "{") depth += 1
    else if (character === ")" || character === "]" || character === "}") depth -= 1
    else if (character === "=" && depth === 0) {
      return { selector: rule.slice(0, index), value: parseValueToken(rule.slice(index + 1), rule) }
    }
  }
  return { selector: rule, value: true }
}

function parseDirectCall(
  access: string,
  moduleName: string | undefined,
  value: FlagValue,
  rule: string,
): FlagDefinition | undefined {
  const opening = access.indexOf("(")
  if (opening < 0) return undefined
  if (!access.endsWith(")") || access.indexOf("(", opening + 1) >= 0) {
    throw new Error(`invalid --set call: ${rule}`)
  }
  const call = access.slice(0, opening)
  if (!/^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/.test(call)) {
    throw new Error(`invalid --set call: ${rule}; expected CALL("key")=true`)
  }
  return {
    ...(moduleName === undefined ? {} : { module: moduleName }),
    call,
    arguments: parseStaticArguments(access.slice(opening + 1, -1), rule),
    value,
  }
}

function parseDirectFlag(rule: string): FlagDefinition {
  const { selector: rawSelector, value: flagValue } = splitValue(rule)
  if (rawSelector.length === 0) {
    throw new Error(`invalid --set rule: ${rule}; expected NAME.path or CALL("key")`)
  }

  const opening = rawSelector.indexOf("(")
  const possibleModuleSeparator = rawSelector.indexOf("#")
  const moduleSeparator =
    possibleModuleSeparator >= 0 && (opening < 0 || possibleModuleSeparator < opening)
      ? possibleModuleSeparator
      : -1
  const moduleName = moduleSeparator < 0 ? undefined : rawSelector.slice(0, moduleSeparator)
  const rawAccess = moduleSeparator < 0 ? rawSelector : rawSelector.slice(moduleSeparator + 1)
  if (moduleName === "") throw new Error(`invalid --set selector: ${rawSelector}`)
  const directCall = parseDirectCall(rawAccess, moduleName, flagValue, rule)
  if (directCall !== undefined) return directCall
  const access = rawAccess.replaceAll("?.", ".")
  const parts = access.split(".")
  if (
    parts.length === 0 ||
    parts.some((part) => !/^[$A-Z_a-z][$\w]*$/.test(part))
  ) {
    throw new Error(`invalid --set selector: ${rawSelector}`)
  }

  const [root, ...path] = parts as [string, ...string[]]
  const shared = {
    ...(path.length === 0 ? {} : { path }),
    value: flagValue,
  }
  return moduleName === undefined
    ? { identifier: root, ...shared }
    : { module: moduleName, export: root, ...shared }
}

function parseArguments(args: string[]): CliArguments {
  const result: CliArguments = {
    directFlags: [],
    write: false,
    check: false,
    diff: true,
    diffExplicit: false,
    color: "auto",
    removeSideEffectImports: false,
    json: false,
    help: false,
    version: false,
    ignore: [],
    strict: false,
    overrides: {},
    targets: [],
  }
  let dryRun = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === "--") {
      result.targets.push(...args.slice(index + 1))
      break
    }
    if (argument === "-s" || argument === "--set") {
      result.directFlags.push(parseDirectFlag(requireValue(args, index, argument)))
      index += 1
    } else if (argument.startsWith("--set=")) {
      result.directFlags.push(parseDirectFlag(argument.slice("--set=".length)))
    } else if (argument.startsWith("-s=")) {
      result.directFlags.push(parseDirectFlag(argument.slice("-s=".length)))
    } else if (argument === "-w" || argument === "--write") result.write = true
    else if (argument === "--dry-run") dryRun = true
    else if (argument === "--check") result.check = true
    else if (argument === "--strict") result.strict = true
    else if (argument === "--diff") {
      result.diff = true
      result.diffExplicit = true
    } else if (argument === "--no-diff") {
      result.diff = false
      result.diffExplicit = true
    }
    else if (argument === "--no-color") result.color = "never"
    else if (argument === "--color") result.color = "always"
    else if (argument.startsWith("--color=")) {
      const value = argument.slice("--color=".length)
      if (value !== "auto" && value !== "always" && value !== "never") {
        throw new Error("--color must be auto, always, or never")
      }
      result.color = value
    }
    else if (argument === "--json") result.json = true
    else if (argument === "--remove-side-effect-imports") result.removeSideEffectImports = true
    else if (argument === "--flatten-blocks") result.overrides.flattenBlocks = true
    else if (argument === "--no-flatten-blocks") result.overrides.flattenBlocks = false
    else if (argument === "--no-remove-unused-imports") result.overrides.removeUnusedImports = false
    else if (argument === "--skip-effectful-conditions") result.overrides.simplifyEffectfulConditions = false
    else if (argument === "--no-parse-check") result.overrides.verify = { ...result.overrides.verify, parse: false }
    else if (argument === "--keep-comments") result.overrides.commentPolicy = "preserve"
    else if (argument === "--comment-policy" || argument.startsWith("--comment-policy=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : requireValue(args, index, argument)
      if (value !== "report" && value !== "preserve" && value !== "discard") {
        throw new Error("--comment-policy must be report, preserve, or discard")
      }
      result.overrides.commentPolicy = value
      if (!argument.includes("=")) index += 1
    } else if (argument === "--max-passes" || argument.startsWith("--max-passes=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : requireValue(args, index, argument)
      const passes = Number(value)
      if (!Number.isInteger(passes) || passes <= 0) throw new Error("--max-passes must be a positive integer")
      result.overrides.maxPasses = passes
      if (!argument.includes("=")) index += 1
    } else if (argument === "--ignore") {
      result.ignore.push(requireValue(args, index, argument))
      index += 1
    } else if (argument.startsWith("--ignore=")) {
      result.ignore.push(argument.slice("--ignore=".length))
    } else if (argument === "-h" || argument === "--help") result.help = true
    else if (argument === "-v" || argument === "--version") result.version = true
    else if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`)
    else result.targets.push(argument)
  }
  if (dryRun && result.write) throw new Error("cannot combine --write and --dry-run")
  if (result.json) result.diff = false
  else if (result.write && !result.diffExplicit) result.diff = false
  return result
}

interface InteractiveSession {
  ask(question: string): Promise<string>
  close(): void
}

function createInteractiveSession(io: CliIo): InteractiveSession {
  const readline = createInterface({
    input: io.stdin ?? process.stdin,
    terminal: false,
  })
  const queuedAnswers: string[] = []
  let inputEnded = false
  let pendingAnswer: ((answer: string | undefined) => void) | undefined
  readline.on("line", (answer) => {
    if (pendingAnswer !== undefined) {
      const resolveAnswer = pendingAnswer
      pendingAnswer = undefined
      resolveAnswer(answer)
    } else {
      queuedAnswers.push(answer)
    }
  })
  readline.on("close", () => {
    inputEnded = true
    pendingAnswer?.(undefined)
    pendingAnswer = undefined
  })
  return {
    ask: async (question) => {
      io.stdout.write(question)
      let answer = queuedAnswers.shift()
      if (answer === undefined && !inputEnded) {
        answer = await new Promise<string | undefined>((resolveAnswer) => {
          pendingAnswer = resolveAnswer
        })
      }
      if (answer === undefined) throw new Error("interactive setup ended before all questions were answered")
      return answer.trim()
    },
    close: () => readline.close(),
  }
}

async function runInteractiveSetup(
  parsed: CliArguments,
  io: CliIo,
  session: InteractiveSession,
): Promise<void> {
  io.stdout.write("Tip: Run `npx flag-prune --help` to see all options.\n\n")
  const selector = await session.ask(
    "What flag would you like to remove?\n" +
    "Enter a name like hasFeature.newAccess or useFlag(\"new-access\").\n" +
    "Flag: ",
  )
  if (selector === "") throw new Error("please enter a flag to remove")

  const rawValue = await session.ask(
    "\nWhat value should replace this flag?\n" +
    "Press Enter to use true. You can also enter false, a number like 3, or text like beta.\n" +
    "Value [true]: ",
  )
  const flag = parseDirectFlag(selector)
  flag.value = rawValue === "" ? true : parseValueToken(rawValue, rawValue)
  parsed.directFlags.push(flag)

  const rawTargets = await session.ask(
    "\nWhere should flag-prune look?\n" +
    "Enter files or directories separated by commas. Press Enter to search the current directory (./).\n" +
    "Paths [./]: ",
  )
  const targets = rawTargets === "" ? ["./"] : rawTargets.split(",").map((target) => target.trim())
  if (targets.some((target) => target === "")) {
    throw new Error("each file or directory must have a name")
  }
  parsed.targets.push(...targets)
  io.stdout.write("\n")
}

async function confirmInteractiveWrite(session: InteractiveSession, io: CliIo): Promise<boolean> {
  while (true) {
    const answer = (await session.ask("\nWrite these changes? [y/N]: ")).toLowerCase()
    if (answer === "y" || answer === "yes") return true
    if (answer === "" || answer === "n" || answer === "no") return false
    io.stdout.write("Please enter y for yes or n for no.\n")
  }
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
  const targetPath = await realpath(path)
  const info = await stat(targetPath)
  const temporary = join(dirname(targetPath), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.flag-prune`)
  try {
    await writeFile(temporary, contents, { mode: info.mode })
    await chmod(temporary, info.mode)
    await rename(temporary, targetPath)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  cyan: "\u001B[36m",
}

/** Decide whether to emit ANSI color, honoring NO_COLOR, FORCE_COLOR, and TTY state. */
function shouldUseColor(mode: "auto" | "always" | "never", io: CliIo): boolean {
  if (mode === "always") return true
  if (mode === "never") return false
  const env = io.env ?? process.env
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return false
  if (typeof env.FORCE_COLOR === "string" && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true
  return io.stdout.isTTY === true
}

/** Add ANSI colors to a unified diff without changing its line structure. */
function colorizePatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return `${ANSI.bold}${line}${ANSI.reset}`
      if (line.startsWith("@@")) return `${ANSI.cyan}${line}${ANSI.reset}`
      if (line.startsWith("+")) return `${ANSI.green}${line}${ANSI.reset}`
      if (line.startsWith("-")) return `${ANSI.red}${line}${ANSI.reset}`
      if (line.startsWith("=")) return `${ANSI.dim}${line}${ANSI.reset}`
      return line
    })
    .join("\n")
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
    blocksFlattened: 0,
    effectsPreserved: 0,
    removedComments: [] as TransformReport["removedComments"],
    warnings: [] as string[],
    passes: 0,
    converged: true,
  }
  for (const result of results) {
    report.flagsReplaced += result.report.flagsReplaced
    report.expressionsFolded += result.report.expressionsFolded
    report.deadBranchesRemoved += result.report.deadBranchesRemoved
    report.unreachableStatementsRemoved += result.report.unreachableStatementsRemoved
    report.importsRemoved += result.report.importsRemoved
    report.bindingsRemoved += result.report.bindingsRemoved
    report.blocksFlattened += result.report.blocksFlattened
    report.effectsPreserved += result.report.effectsPreserved
    report.removedComments.push(...result.report.removedComments)
    report.warnings.push(...result.report.warnings.map((warning) => `${result.path}: ${warning}`))
    report.passes = Math.max(report.passes, result.report.passes)
    report.converged = report.converged && result.report.converged
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
    `${count(report.unreachableStatementsRemoved, "unreachable statement")} removed`,
    `${count(report.importsRemoved, "import")} removed`,
    `${count(report.bindingsRemoved, "binding")} removed`,
    `${count(report.blocksFlattened, "block")} de-scoped`,
    `${count(report.effectsPreserved, "effectful expression")} preserved`,
    `${count(report.removedComments.filter((comment) => !comment.retained).length, "comment")} removed and reported`,
    count(report.warnings.length, "warning"),
  ].join("\n")
}

function createConfig(parsed: CliArguments): FlagCleanConfig {
  const config = validateConfig({
    ...parsed.overrides,
    ...(parsed.removeSideEffectImports ? { removeSideEffectImports: true } : {}),
    flags: parsed.directFlags,
  })
  if (config.flags.length === 0) {
    throw new Error("no flags provided; use --set NAME.path[=value]")
  }
  return config
}

export async function runCli(
  args: string[],
  io: CliIo = { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let interactiveSession: InteractiveSession | undefined
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
    if (args.length === 0) {
      if ((io.env ?? process.env).CI !== "true") {
        interactiveSession = createInteractiveSession(io)
        await runInteractiveSetup(parsed, io, interactiveSession)
      } else {
        throw new Error("no arguments provided in CI environment; use --help for usage")
      }
    }
    if (parsed.targets.length === 0) throw new Error("provide at least one file or directory")
    const config = createConfig(parsed)
    const { files, warnings: discoveryWarnings } = await collectFiles(io.cwd, parsed.targets, parsed.ignore)
    for (const warning of discoveryWarnings) io.stderr.write(`warning: ${warning}\n`)
    if (files.length === 0) {
      io.stderr.write("flag-prune: no files found\n")
      return 0
    }

    const results: FileResult[] = []
    const skipped: string[] = []
    for (const path of files) {
      const source = await readFile(path, "utf8")
      try {
        const result = transform(source, { ...config, filename: relative(io.cwd, path) })
        results.push({ path, source, ...result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        skipped.push(`skipped ${relative(io.cwd, path)}: ${message}`)
      }
    }
    for (const warning of skipped) io.stderr.write(`warning: ${warning}\n`)
    const report = aggregateReports(results)
    const changed = results.filter((result) => result.changed)

    const nonConverged = results.filter((result) => !result.report.converged)
    if (nonConverged.length > 0) {
      const names = nonConverged.map((result) => relative(io.cwd, result.path)).join(", ")
      throw new Error(`transform did not reach a fixed point for: ${names}; raise maxPasses or report a bug`)
    }

    let changesWritten = parsed.write && changed.length > 0
    if (changesWritten) {
      for (const result of changed) await atomicWrite(result.path, result.code)
    }

    if (parsed.diff) {
      const useColor = shouldUseColor(parsed.color, io)
      for (const result of results) {
        if (!result.changed) continue
        const label = relative(io.cwd, result.path).replaceAll("\\", "/")
        const patch = createTwoFilesPatch(`a/${label}`, `b/${label}`, result.source, result.code, "before", "after")
        io.stdout.write(useColor ? colorizePatch(patch) : patch)
      }
    }
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify({ report, files: results.map(({ path, changed: fileChanged, report: fileReport }) => ({ path, changed: fileChanged, report: fileReport })) }, null, 2)}\n`)
    } else {
      io.stdout.write(`${humanSummary(report)}\n`)
      for (const warning of report.warnings) io.stderr.write(`warning: ${warning}\n`)
    }

    if (
      interactiveSession !== undefined &&
      changed.length > 0 &&
      await confirmInteractiveWrite(interactiveSession, io)
    ) {
      for (const result of changed) await atomicWrite(result.path, result.code)
      changesWritten = true
      io.stdout.write(`Changes written to ${changed.length} ${changed.length === 1 ? "file" : "files"}.\n`)
    }
    if (changed.length > 0 && !parsed.json) {
      io.stdout.write(
        changesWritten
          ? "Next: run your project's typecheck, lint, and tests.\n"
          : "After writing these changes, run your project's typecheck, lint, and tests.\n",
      )
    }
    if (parsed.strict && (report.warnings.length > 0 || discoveryWarnings.length > 0 || skipped.length > 0)) return 2
    return parsed.check && report.filesChanged > 0 ? 1 : 0
  } catch (error) {
    io.stderr.write(`flag-prune: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  } finally {
    interactiveSession?.close()
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(resolve(fileURLToPath(import.meta.url)))
if (isEntryPoint) {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: { write: (value) => writeSync(1, value), isTTY: process.stdout.isTTY },
    stderr: { write: (value) => writeSync(2, value) },
  })
}
