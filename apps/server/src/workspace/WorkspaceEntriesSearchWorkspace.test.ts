import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type CodeWorkspace } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const withWorkspace = Effect.fn(function* <E, R>(
  check: (
    entries: WorkspaceEntries.WorkspaceEntries["Service"],
    workspace: CodeWorkspace,
  ) => Effect.Effect<void, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-search-" });
  const base = yield* fs.realPath(temporary);
  const workspace: CodeWorkspace = {
    filePath: path.join(base, "team.code-workspace"),
    workspaceRoot: path.join(base, "empty"),
    folders: ["empty", "one", "two"].map((name, index) => ({
      id: `root-${index}`,
      name,
      path: path.join(base, name),
    })),
    repositories: [],
  };
  for (const root of workspace.folders) yield* fs.makeDirectory(root.path);
  const layer = WorkspaceEntries.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () => Effect.succeed(Option.some({ workspace } as unknown as ProjectStore.ProjectRow)),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(base, path.join(base, "state"))),
  );
  yield* Effect.gen(function* () {
    yield* check(yield* WorkspaceEntries.WorkspaceEntries, workspace);
  }).pipe(Effect.provide(layer));
});

const searchInput = { cwd: "/unused", projectId: ProjectId.make("search-project") };

it.effect("ranks a later exact match globally even with limit one and keeps scores internal", () =>
  withWorkspace((entries, workspace) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(workspace.folders[1]!.path, "target-other.ts"), "");
      yield* fs.writeFileString(path.join(workspace.folders[2]!.path, "target.ts"), "");
      for (const kind of ["file", undefined] as const) {
        const result = yield* entries.search({
          ...searchInput,
          query: "target.ts",
          limit: 1,
          ...(kind ? { kind } : {}),
        });
        assert.deepEqual(result.entries, [
          { path: "target.ts", kind: "file", root: workspace.folders[2]! },
        ]);
        assert.equal(result.truncated, true);
        assert.ok(!("scores" in result));
      }
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fills the page from a busy root and reports global truncation", () =>
  withWorkspace((entries, workspace) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const name of ["target-a.ts", "target-b.ts", "target-c.ts"])
        yield* fs.writeFileString(path.join(workspace.folders[1]!.path, name), "");
      const full = yield* entries.search({
        ...searchInput,
        query: "target",
        kind: "file",
        limit: 3,
      });
      assert.deepEqual(full.entries.map((entry) => entry.path).sort(), [
        "target-a.ts",
        "target-b.ts",
        "target-c.ts",
      ]);
      assert.equal(full.truncated, false);
      const limited = yield* entries.search({
        ...searchInput,
        query: "target",
        kind: "file",
        limit: 2,
      });
      assert.equal(limited.entries.length, 2);
      assert.equal(limited.truncated, true);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps filtered image scores aligned and searches an exact root prefix safely", () =>
  withWorkspace((entries, workspace) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(workspace.folders[1]!.path, "target"), "");
      yield* fs.writeFileString(path.join(workspace.folders[1]!.path, "t-a-r-g-e-t.svg"), "");
      yield* fs.writeFileString(path.join(workspace.folders[2]!.path, "target.svg"), "");
      const images = yield* entries.search({
        ...searchInput,
        query: "target",
        imageOnly: true,
        limit: 1,
      });
      assert.deepEqual(images.entries, [
        { path: "target.svg", kind: "file", root: workspace.folders[2]! },
      ]);
      assert.equal(images.truncated, true);
      const qualified = yield* entries.search({
        ...searchInput,
        query: "two/",
        kind: "file",
        limit: 1,
      });
      assert.deepEqual(qualified.entries, [
        { path: "target.svg", kind: "file", root: workspace.folders[2]! },
      ]);
      assert.equal(qualified.truncated, false);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retains duplicate names across roots and reports failures beyond a small limit", () =>
  withWorkspace((entries, workspace) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const root of workspace.folders.slice(1))
        yield* fs.writeFileString(path.join(root.path, "same.txt"), "");
      const both = yield* entries.search({ ...searchInput, query: "same", kind: "file", limit: 2 });
      assert.deepEqual(
        both.entries.map((entry) => entry.root?.id),
        ["root-1", "root-2"],
      );
      assert.equal(both.truncated, false);
      yield* fs.remove(workspace.folders[2]!.path, { recursive: true });
      const partial = yield* entries.search({
        ...searchInput,
        query: "same",
        kind: "file",
        limit: 1,
      });
      assert.deepEqual(partial.entries, [
        { path: "same.txt", kind: "file", root: workspace.folders[1]! },
      ]);
      assert.equal(partial.rootErrors?.[0]?.root.id, "root-2");
      assert.equal(partial.truncated, false);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ranks directory matches after filtering each root's empty directory", () =>
  withWorkspace((entries, workspace) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workspace.folders[1]!.path, "t-a-r-g-e-t"));
      yield* fs.makeDirectory(path.join(workspace.folders[2]!.path, "target"));
      yield* fs.writeFileString(
        path.join(workspace.folders[1]!.path, "t-a-r-g-e-t", "file.ts"),
        "",
      );
      yield* fs.writeFileString(path.join(workspace.folders[2]!.path, "target", "file.ts"), "");
      const result = yield* entries.search({
        ...searchInput,
        query: "target",
        kind: "directory",
        limit: 1,
      });
      assert.deepEqual(result.entries, [
        { path: "target", kind: "directory", root: workspace.folders[2]! },
      ]);
      assert.equal(result.truncated, true);
      const qualified = yield* entries.search({
        ...searchInput,
        query: "two/",
        kind: "directory",
        limit: 1,
      });
      assert.deepEqual(qualified.entries, [
        { path: "target", kind: "directory", root: workspace.folders[2]! },
      ]);
      assert.equal(qualified.truncated, false);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
