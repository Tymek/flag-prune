import { chmod, rm } from "node:fs/promises"
import { execFile } from "node:child_process"
import { resolve } from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { build } from "esbuild"

const run = promisify(execFile)

await rm("dist", { recursive: true, force: true })
await run(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"])

await build({
  entryPoints: [
    "src/index.ts",
    "src/analysis.ts",
    "src/config.ts",
    "src/matchers.ts",
    "src/simplify.ts",
    "src/transform.ts",
  ],
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  bundle: false,
})

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  bundle: true,
  external: ["recast"],
  banner: { js: "#!/usr/bin/env node" },
})

await chmod("dist/cli.js", 0o755)
