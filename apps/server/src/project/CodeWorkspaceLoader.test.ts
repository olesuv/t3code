import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as CodeWorkspaceLoader from "./CodeWorkspaceLoader.ts";

const layer = CodeWorkspaceLoader.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
  const base = yield* fs.realPath(temp);
  const meta = path.join(base, "meta");
  const children = ["one", "two"].map((name) => path.join(meta, name));
  const external = path.join(base, "external");
  const plain = path.join(base, "plain");
  for (const dir of [meta, ...children, external, plain]) {
    yield* fs.makeDirectory(dir, { recursive: true });
  }
  for (const dir of [meta, ...children, external]) {
    const result = yield* runner.run({ command: "git", args: ["init", dir] });
    expect(result.code).toBe(0);
  }
  yield* fs.makeDirectory(path.join(children[0]!, "nested"));
  const filePath = path.join(meta, "all.code-workspace");
  return { fs, path, base, meta, children, external, plain, filePath };
});

it.layer(layer)("CodeWorkspaceLoader", (it) => {
  it.effect(
    "loads named nested and external roots, includes meta, and deduplicates Git checkouts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.symlink(f.children[0]!, f.path.join(f.meta, "alias"));
        yield* f.fs.writeFileString(
          f.filePath,
          `{
        // Editor configuration does not affect project membership.
        "settings": { "text": "https://example.com/a,]" },
        "folders": [
          { "path": "one", "name": "First" },
          { "path": "one/nested" },
          { "path": "alias", "name": "Alias" },
          { "path": "two" },
          { "path": ${JSON.stringify(f.external)} },
          { "path": "../plain" },
        ],
      }`,
        );
        const loader = yield* CodeWorkspaceLoader.CodeWorkspaceLoader;
        const loaded = yield* loader.load(f.filePath);
        expect(loaded.workspaceRoot).toBe(f.meta);
        expect(loaded.workspace.filePath).toBe(f.filePath);
        expect(loaded.workspace.folders.map((folder) => folder.name)).toEqual([
          "First",
          "nested",
          "Alias",
          "two",
          "external",
          "plain",
        ]);
        expect(loaded.workspace.folders[0]?.id).toBe(loaded.workspace.folders[2]?.id);
        expect(loaded.workspace.repositories.map((repo) => repo.checkoutPath)).toEqual([
          f.meta,
          ...f.children,
          f.external,
        ]);
        expect(loaded.workspace.repositories.map((repo) => repo.name)).toEqual([
          "meta",
          "First",
          "two",
          "external",
        ]);
        // An unlisted repository is never discovered recursively.
        yield* f.fs.makeDirectory(f.path.join(f.meta, "unlisted"));
        const again = yield* loader.load(f.filePath);
        expect(again).toEqual(loaded);
      }),
  );

  it.effect(
    "uses the file directory without Git and keeps separate workspace file identities",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const loader = yield* CodeWorkspaceLoader.CodeWorkspaceLoader;
        const first = f.path.join(f.plain, "first.code-workspace");
        const second = f.path.join(f.plain, "second.code-workspace");
        for (const file of [first, second])
          yield* f.fs.writeFileString(file, '{"folders": [{"path": "."}]}');
        const a = yield* loader.load(first);
        const b = yield* loader.load(second);
        expect(a.workspaceRoot).toBe(f.plain);
        expect(a.workspace.repositories).toEqual([]);
        expect(a.workspace.filePath).not.toBe(b.workspace.filePath);
        expect(a.workspace.folders).toEqual(b.workspace.folders);
        yield* f.fs.writeFileString(first, '{"folders": []}');
        expect((yield* loader.load(first)).workspace.folders).toEqual([]);
        expect(a.workspace.folders).toHaveLength(1);
      }),
  );

  it.effect.each([
    ['{"folders": [}', "malformed"],
    ['{"folders": []} /* unterminated', "malformed"],
    ['{"folders": [{"path": "one" "name": "oops"}]}', "malformed"],
    ["{}", "malformed"],
    ['{"folders": [{"uri": "file:///repo"}]}', "uri"],
    ['{"folders": [{"path": "one", "uri": "file:///repo"}]}', "uri"],
    ['{"folders": [{}]}', "folder-path"],
    ['{"folders": [{"path": "  "}]}', "folder-path"],
    ['{"folders": [{"path": "file:///repo"}]}', "folder-path"],
    ['{"folders": [{"path": "missing"}]}', "folder-missing"],
    ['{"folders": [{"path": "all.code-workspace"}]}', "folder-not-directory"],
  ] as const)("rejects %s with %s", ([contents, reason]) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(f.filePath, contents);
      const loader = yield* CodeWorkspaceLoader.CodeWorkspaceLoader;
      const error = yield* loader.load(f.filePath).pipe(Effect.flip);
      expect(error.reason).toBe(reason);
      expect(error.message).toContain(f.filePath);
    }),
  );

  it.effect("reports an unreadable or missing workspace file", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const loader = yield* CodeWorkspaceLoader.CodeWorkspaceLoader;
      const error = yield* loader.load(f.filePath).pipe(Effect.flip);
      expect(error.reason).toBe("read");
    }),
  );
});
