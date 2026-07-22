import type { FlagCleanConfig, FlagDefinition } from "./types.js"

function fail(message: string): never {
  throw new TypeError(`Invalid flag-prune config: ${message}`)
}

const ALLOWED_FLAG_KEYS = new Set([
  "module",
  "export",
  "identifier",
  "path",
  "call",
  "arguments",
  "optional",
  "value",
])
const ALLOWED_CONFIG_KEYS = new Set([
  "flags",
  "simplifyEffectfulConditions",
  "removeUnusedImports",
  "removeSideEffectImports",
  "commentPolicy",
  "maxPasses",
  "solverVariableLimit",
  "verify",
  "filename",
])
const ALLOWED_VERIFY_KEYS = new Set(["parse", "typecheck", "lint", "tests"])

function validateFlag(flag: unknown, index: number): FlagDefinition {
  if (typeof flag !== "object" || flag === null || Array.isArray(flag)) {
    fail(`flags[${index}] must be an object`)
  }

  const value = flag as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FLAG_KEYS.has(key)) fail(`flags[${index}] has unknown key "${key}"`)
  }
  if (value.value !== undefined && typeof value.value !== "boolean") fail(`flags[${index}].value must be boolean`)
  if (value.module !== undefined && typeof value.module !== "string") fail(`flags[${index}].module must be string`)
  if (value.export !== undefined && typeof value.export !== "string") fail(`flags[${index}].export must be string`)
  if (value.identifier !== undefined && typeof value.identifier !== "string") fail(`flags[${index}].identifier must be string`)
  if (value.call !== undefined && typeof value.call !== "string") fail(`flags[${index}].call must be string`)
  if (typeof value.call === "string" && !/^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/.test(value.call)) {
    fail(`flags[${index}].call must be a static dotted function name`)
  }
  if (value.optional !== undefined && typeof value.optional !== "boolean") fail(`flags[${index}].optional must be boolean`)
  if (value.path !== undefined && (!Array.isArray(value.path) || value.path.some((part) => typeof part !== "string"))) {
    fail(`flags[${index}].path must be a string array`)
  }
  if (
    value.arguments !== undefined &&
    (!Array.isArray(value.arguments) ||
      value.arguments.some(
        (argument) => argument !== null && !["string", "number", "boolean"].includes(typeof argument),
      ))
  ) {
    fail(`flags[${index}].arguments must contain only JSON primitive values`)
  }

  if (value.call === undefined && value.export === undefined && value.identifier === undefined) {
    fail(`flags[${index}] needs one of call, export, or identifier`)
  }
  if (value.call !== undefined && (value.export !== undefined || value.identifier !== undefined)) {
    fail(`flags[${index}] cannot combine call with export or identifier`)
  }
  if (value.module !== undefined && value.identifier !== undefined) {
    fail(`flags[${index}] cannot combine module with identifier`)
  }

  return { ...value, value: value.value ?? true } as unknown as FlagDefinition
}

export function validateConfig(input: unknown): FlagCleanConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("root must be an object")
  const value = input as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) fail(`unknown config key "${key}"`)
  }
  if (!Array.isArray(value.flags)) fail("flags must be an array")
  const flags = value.flags.map(validateFlag)
  const commentPolicies = ["report", "preserve", "discard"]
  if (value.commentPolicy !== undefined && !commentPolicies.includes(String(value.commentPolicy))) {
    fail("commentPolicy must be report, preserve, or discard")
  }
  for (const key of ["simplifyEffectfulConditions", "removeUnusedImports", "removeSideEffectImports"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") fail(`${key} must be boolean`)
  }
  for (const key of ["maxPasses", "solverVariableLimit"] as const) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) <= 0)) {
      fail(`${key} must be a positive integer`)
    }
  }
  if (value.verify !== undefined) {
    if (typeof value.verify !== "object" || value.verify === null || Array.isArray(value.verify)) {
      fail("verify must be an object")
    }
    for (const key of Object.keys(value.verify as Record<string, unknown>)) {
      if (!ALLOWED_VERIFY_KEYS.has(key)) fail(`verify has unknown key "${key}"`)
    }
  }

  return { ...(value as unknown as FlagCleanConfig), flags }
}
