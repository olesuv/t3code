import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  workspaceFileRoots,
  type CodeWorkspace,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
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

it.effect(
  "browses and searches named roots using frozen thread membership and current project membership",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-files-" });
      const meta = yield* fs.realPath(temporary);
      const one = path.join(meta, "one");
      const two = path.join(meta, "two");
      const external = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-external-" }),
        "checkout",
      );
      const notes = path.join(meta, "notes");
      for (const directory of [one, two, notes, external]) {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "same.txt"), "needle\n");
      }
      const workspace: CodeWorkspace = {
        filePath: path.join(meta, "team.code-workspace"),
        workspaceRoot: meta,
        folders: [one, two, external, notes].map((folder, index) => ({
          id: `root-${index}`,
          name: ["One", "Two", "External", "Notes"][index]!,
          path: folder,
        })),
        repositories: [
          {
            id: "external-repository",
            name: "External repository",
            checkoutPath: path.dirname(external),
          },
        ],
      };
      const reloaded = { ...workspace, folders: workspace.folders.slice(0, 1), repositories: [] };
      const threadId = ThreadId.make("workspace-thread");
      const projectId = ProjectId.make("workspace-project");
      const layer = WorkspaceEntries.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.succeed({ workspace } as unknown as OrchestrationV2ThreadShell),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () =>
              Effect.succeed(
                Option.some({ workspace: reloaded } as unknown as ProjectStore.ProjectRow),
              ),
          }),
        ),
        Layer.provide(ServerConfig.layerTest(meta, path.join(meta, "state"))),
      );
      yield* Effect.gen(function* () {
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const roots = yield* entries.list({ cwd: "/client/path/is/not/authoritative", threadId });
        assert.deepEqual(roots.roots, workspaceFileRoots(workspace));
        const current = yield* entries.list({ cwd: meta, projectId });
        assert.equal(current.roots?.length, 2);
        const listed = yield* entries.list({
          cwd: meta,
          threadId,
          rootId: "root-2",
          directoryPath: "",
        });
        assert.equal(listed.entries[0]?.root?.name, "External");
        assert.equal(listed.entries[0]?.path, "same.txt");
        const repositoryFiles = yield* entries.list({
          cwd: meta,
          threadId,
          rootId: "external-repository",
          directoryPath: "checkout",
        });
        assert.equal(repositoryFiles.entries[0]?.path, "checkout/same.txt");
        assert.equal(repositoryFiles.entries[0]?.root?.id, "external-repository");
        const found = yield* entries.search({
          cwd: meta,
          threadId,
          query: "same",
          kind: "file",
          limit: 30,
        });
        for (const root of workspace.folders)
          assert.ok(
            found.entries.find((entry) => entry.root?.id === root.id && entry.path === "same.txt"),
          );
        const qualified = yield* entries.search({
          cwd: meta,
          threadId,
          query: "External/same",
          kind: "file",
          limit: 30,
        });
        assert.deepEqual(
          qualified.entries.map((entry) => entry.root?.id),
          ["root-2"],
        );
        const contents = yield* entries.searchContents({
          cwd: meta,
          threadId,
          query: "needle",
          limit: 30,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });
        assert.ok(
          contents.matches.find(
            (entry) => entry.root?.id === "root-2" && entry.path === "same.txt",
          ),
        );
        const invalid = yield* entries
          .list({ cwd: meta, threadId, rootId: "not-a-root" })
          .pipe(Effect.flip);
        assert.equal(invalid._tag, "WorkspaceEntriesWorkspaceError");
        yield* fs.remove(external, { recursive: true });
        const partial = yield* entries.search({
          cwd: meta,
          threadId,
          query: "same",
          kind: "file",
          limit: 30,
        });
        assert.ok(partial.rootErrors?.find((entry) => entry.root.id === "root-2"));
        assert.ok(partial.entries.find((entry) => entry.root?.id === "root-0"));
        assert.isAtMost(partial.entries.length, 30);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
