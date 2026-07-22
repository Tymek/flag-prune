import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { promisify } from "node:util"

const run = promisify(execFile)
const temporary = await mkdtemp(join(tmpdir(), "flag-prune-package-"))

try {
  await run("pnpm", ["pack", "--pack-destination", temporary], { cwd: resolve(".") })
  const entries = await readdir(temporary)
  const tarball = entries.find((entry) => entry.endsWith(".tgz"))
  assert.ok(tarball)
  const packed = join(temporary, tarball)
  const consumer = join(temporary, "consumer")
  await mkdir(consumer)
  await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module", private: true }))
  await run("npm", ["install", "--ignore-scripts", packed], {
    cwd: consumer,
    env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") },
  })
  await writeFile(
    join(consumer, "use.mjs"),
    `import assert from "node:assert/strict"\nimport { transform } from "flag-prune"\nconst result = transform("if (FLAG) yes(); else no()", { flags: [{ identifier: "FLAG", value: true }] })\nassert.equal(result.code, "yes();\\n")\n`,
  )
  await run(process.execPath, ["use.mjs"], { cwd: consumer })

  await writeFile(join(consumer, "input.js"), "if (FLAG) yes(); else no()\n")
  await writeFile(
    join(consumer, "flags.json"),
    JSON.stringify({ flags: [{ identifier: "FLAG", value: false }] }),
  )
  const cli = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "flag-prune.cmd" : "flag-prune")
  const cliResult = await run(cli, ["--config", "flags.json", "--write", "input.js"], { cwd: consumer })
  assert.match(cliResult.stdout, /1 flag replaced/)
  assert.equal(await readFile(join(consumer, "input.js"), "utf8"), "no();\n")

  await writeFile(
    join(consumer, "call.js"),
    'const enabled = useFlag("new-ui")\nif (enabled) yes(); else no();\n',
  )
  await run(cli, ["--flag", 'useFlag("new-ui")=true', "--write", "call.js"], { cwd: consumer })
  assert.equal(await readFile(join(consumer, "call.js"), "utf8"), "yes();\n")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
