import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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
  const plain = path.join(base, "plain-你好-é-🚀");
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
          { "path": "../plain-你好-é-🚀" },
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
          "plain-你好-é-🚀",
        ]);
        const runner = yield* ProcessRunner.ProcessRunner;
        const legacyId = Effect.fnUntraced(function* (kind: string, canonicalPath: string) {
          const result = yield* runner.run({
            command: process.execPath,
            args: [
              "-e",
              'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))',
              canonicalPath,
            ],
          });
          expect(result.code).toBe(0);
          return `${kind}-${result.stdout}`;
        });
        for (const folder of loaded.workspace.folders) {
          expect(folder.id).toBe(yield* legacyId("folder", folder.path));
        }
        for (const repository of loaded.workspace.repositories) {
          expect(repository.id).toBe(yield* legacyId("repository", repository.checkoutPath));
        }
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
    ["fatal: not a git repository (or any of the parent directories): .git", true],
    ["fatal: cannot open .git/config: Permission denied", false],
    ["fatal: bad config line 1 in file .git/config", false],
  ] as const)("handles Git discovery failure: %s", ([stderr, isNonGit]) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const filePath = f.path.join(f.plain, "localized.code-workspace");
      yield* f.fs.makeDirectory(f.path.join(f.plain, "folder"));
      yield* f.fs.writeFileString(filePath, '{"folders": [{"path": "folder"}]}');
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const mockProcesses = Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) => {
          calls.push(input);
          return Effect.succeed({
            stdout: "",
            stderr:
              input.env?.LC_ALL === "C"
                ? stderr
                : "fatal : ni ceci ni aucun de ses répertoires parents n'est un dépôt git : .git",
            code: ChildProcessSpawner.ExitCode(128),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        },
      });
      yield* Effect.gen(function* () {
        const loader = yield* CodeWorkspaceLoader.CodeWorkspaceLoader;
        if (isNonGit) {
          const loaded = yield* loader.load(filePath);
          expect(loaded.workspaceRoot).toBe(f.plain);
          expect(loaded.workspace.repositories).toEqual([]);
          expect(loaded.workspace.folders[0]?.path).toBe(f.path.join(f.plain, "folder"));
          expect(calls).toHaveLength(2);
        } else {
          const error = yield* loader.load(filePath).pipe(Effect.flip);
          expect(error.reason).toBe("git");
        }
      }).pipe(
        Effect.provide(Layer.fresh(CodeWorkspaceLoader.layer).pipe(Layer.provide(mockProcesses))),
      );
      expect(calls.every((input) => input.env?.LC_ALL === "C")).toBe(true);
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
