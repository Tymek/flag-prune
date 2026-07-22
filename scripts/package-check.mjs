import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { promisify } from "node:util"

const run = promisify(execFile)
const temporary = await mkdtemp(join(tmpdir(), "flag-prune-pack-check-"))

try {
  await run("pnpm", ["pack", "--pack-destination", temporary], { cwd: resolve(".") })
  const tarball = (await readdir(temporary)).find((entry) => entry.endsWith(".tgz"))
  assert.ok(tarball, "pnpm pack did not create a tarball")
  const packed = join(temporary, tarball)
  await run(resolve("node_modules/.bin/publint"), [packed])
  await run(resolve("node_modules/.bin/attw"), ["--profile", "esm-only", packed])
  process.stdout.write("Packed artifact passes publint and ESM type-resolution checks.\n")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
