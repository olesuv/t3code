// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import { build } from "vite-plus/pack";

import serverConfig from "../../apps/server/vite.config.ts";

it("parses workspace JSONC from the CLI bundle without installed parser modules", async () => {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-jsonc-package-"));
  try {
    const entry = NodePath.join(scratch, "probe.mjs");
    const output = NodePath.join(scratch, "package");
    const modules = NodePath.join(scratch, "node_modules");
    await NodeFSP.cp(
      NodeURL.fileURLToPath(
        new URL("../../apps/server/node_modules/jsonc-parser", import.meta.url),
      ),
      NodePath.join(modules, "jsonc-parser"),
      { recursive: true, dereference: true },
    );
    await NodeFSP.writeFile(
      entry,
      `
      import assert from 'node:assert/strict';
      import { parse } from 'jsonc-parser';
      const errors = [];
      const workspace = parse('{ /* workspace */ "folders": [{ "path": "." },], }', errors, { allowTrailingComma: true });
      assert.deepEqual(errors, []);
      assert.deepEqual(workspace, { folders: [{ path: '.' }] });
      const malformedErrors = [];
      parse('{"folders": [}', malformedErrors, { allowTrailingComma: true });
      assert.ok(malformedErrors.length > 0);
      console.log('Bundled workspace JSONC parsed successfully');
    `,
    );
    const pack = serverConfig.pack;
    assert.ok(pack && typeof pack === "object" && !Array.isArray(pack));
    await build({
      ...pack,
      config: false,
      entry: [entry],
      outDir: output,
      sourcemap: false,
      dts: false,
      logLevel: "error",
    });
    await NodeFSP.rm(modules, { recursive: true, force: true });
    const stdout = NodeChildProcess.execFileSync(
      process.execPath,
      ["--no-global-search-paths", NodePath.join(output, "probe.mjs")],
      { cwd: output, encoding: "utf8", timeout: 30_000 },
    );
    assert.include(stdout, "Bundled workspace JSONC parsed successfully");
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
