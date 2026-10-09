import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as CodeWorkspaceLoader from "../project/CodeWorkspaceLoader.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ReviewService from "./ReviewService.ts";

it.effect("reviews an unborn workspace repository without reporting its new files as empty", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-unborn-" });
    const root = yield* fs.realPath(temporary);
    const dependencies = Layer.mergeAll(
      GitVcsDriver.layer,
      VcsProcess.layer,
      ProcessRunner.layer,
      ServerSettings.layerTest(),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      yield* git.execute({
        operation: "workspace.fixture",
        cwd: root,
        args: ["init", "-b", "main"],
      });
      yield* fs.writeFileString(path.join(root, "new.txt"), "first file\n");
      const filePath = path.join(root, "unborn.code-workspace");
      yield* fs.writeFileString(filePath, '{"folders":[{"path":".","name":"New"}]}');
      const { workspace } = yield* CodeWorkspaceLoader.CodeWorkspaceLoader.use((loader) =>
        loader.load(filePath),
      ).pipe(Effect.provide(CodeWorkspaceLoader.layer));
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const threadId = ThreadId.make("unborn-thread");
        const summary = yield* review.getDiffPreview({ cwd: root, threadId });
        assert.equal(summary.repositories?.length, 1);
        const entry = summary.repositories![0]!;
        assert.isUndefined(entry.error);
        assert.isTrue(
          entry.sources.every((source) => source.files?.some((file) => file.path === "new.txt")),
        );
        const patch = yield* review.getDiffPreview({
          cwd: root,
          threadId,
          repositoryId: entry.repository.id,
          file: { path: "new.txt", previousPath: null, sourceKind: "working-tree" },
        });
        assert.include(patch.sources[0]!.diff, "+first file");
      }).pipe(
        Effect.provide(
          ReviewService.layer.pipe(
            Layer.provide(VcsDriverRegistry.layer),
            Layer.provide(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadShell: () =>
                  Effect.succeed({ workspace } as unknown as OrchestrationV2ThreadShell),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(dependencies));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "groups real workspace diffs, resolves independent bases, and isolates checkout failures",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-review-" });
      const root = yield* fs.realPath(temporary);
      const meta = path.join(root, "meta");
      const external = path.join(root, "external");
      const threadId = ThreadId.make("workspace-review-thread");
      const configuration = ServerConfig.layerTest(meta, path.join(root, "state"));
      const dependencies = Layer.mergeAll(
        GitVcsDriver.layer,
        VcsProcess.layer,
        ServerSettings.layerTest(),
        ProcessRunner.layer,
      ).pipe(Layer.provideMerge(configuration), Layer.provideMerge(NodeServices.layer));
      yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const run = (cwd: string, args: readonly string[]) =>
          git.execute({ operation: "workspace.fixture", cwd, args });
        for (const [cwd, branch] of [
          [meta, "main"],
          [path.join(meta, "one"), "primary"],
          [path.join(meta, "two"), "trunk"],
          [external, "release"],
        ]) {
          yield* fs.makeDirectory(cwd!, { recursive: true });
          yield* run(cwd!, ["init", "-b", branch!]);
          yield* run(cwd!, ["config", "user.name", "Test"]);
          yield* run(cwd!, ["config", "user.email", "test@example.com"]);
          yield* fs.writeFileString(path.join(cwd!, "same.txt"), "before\n");
          yield* fs.writeFileString(path.join(cwd!, "rename.txt"), "renamed contents\n");
          yield* fs.writeFile(path.join(cwd!, "binary.bin"), new Uint8Array([0, 1, 2]));
          yield* run(cwd!, ["add", "."]);
          yield* run(cwd!, ["commit", "-m", "initial"]);
          yield* run(cwd!, ["remote", "add", "origin", path.join(root, "unused-remote")]);
          yield* run(cwd!, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            `refs/remotes/origin/${branch}`,
          ]);
          yield* run(cwd!, ["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
          yield* run(cwd!, ["checkout", "-b", "feature"]);
          yield* fs.writeFileString(path.join(cwd!, "same.txt"), "committed\n");
          yield* run(cwd!, ["add", "same.txt"]);
          yield* run(cwd!, ["commit", "-m", "change"]);
          yield* fs.writeFileString(path.join(cwd!, "same.txt"), "working\n");
          yield* fs.writeFileString(path.join(cwd!, "untracked.txt"), "new\n");
          yield* run(cwd!, ["mv", "rename.txt", "renamed.txt"]);
          yield* fs.writeFile(path.join(cwd!, "binary.bin"), new Uint8Array([0, 9, 8]));
        }
        const notes = path.join(meta, "notes");
        yield* fs.makeDirectory(notes);
        const filePath = path.join(meta, "team.code-workspace");
        yield* fs.writeFileString(
          filePath,
          JSON.stringify({
            folders: [
              { path: "one", name: "One" },
              { path: "two", name: "Two" },
              { path: external, name: "External" },
              { path: "notes", name: "Notes" },
            ],
          }),
        );
        const { workspace } = yield* CodeWorkspaceLoader.CodeWorkspaceLoader.use((loader) =>
          loader.load(filePath),
        ).pipe(Effect.provide(CodeWorkspaceLoader.layer));
        const reviewLayer = ReviewService.layer.pipe(
          Layer.provide(VcsDriverRegistry.layer),
          Layer.provide(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () =>
                Effect.succeed({ workspace } as unknown as OrchestrationV2ThreadShell),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          const preview = yield* service.getDiffPreview({ cwd: meta, threadId });
          assert.equal(preview.repositories?.length, 4);
          assert.deepEqual(preview.sources, []);
          assert.isTrue(
            preview.repositories!.every(
              (entry) => !entry.error && entry.sources.every((source) => source.diff === ""),
            ),
          );
          assert.deepEqual(
            preview.repositories!.map(
              (entry) => entry.sources.find((source) => source.kind === "branch-range")?.baseRef,
            ),
            ["origin/main", "origin/primary", "origin/trunk", "origin/release"],
          );
          const externalEntry = preview.repositories!.find(
            (entry) => entry.repository.name === "External",
          )!;
          assert.include(
            externalEntry.sources
              .find((source) => source.kind === "working-tree")!
              .files!.map((entry) => entry.path),
            "untracked.txt",
          );
          const workingFiles = externalEntry.sources.find(
            (source) => source.kind === "working-tree",
          )!.files!;
          assert.ok(workingFiles.find((entry) => entry.path === "binary.bin"));
          assert.ok(
            workingFiles.find(
              (entry) => entry.path === "renamed.txt" && entry.previousPath === "rename.txt",
            ),
          );
          const selected = yield* service.getDiffPreview({
            cwd: external,
            threadId,
            repositoryId: externalEntry.repository.id,
            file: { path: "same.txt", previousPath: null, sourceKind: "working-tree" },
          });
          assert.include(selected.sources[0]!.diff, "+working");
          const contents = yield* service.getDiffFileContents({
            cwd: external,
            threadId,
            repositoryId: externalEntry.repository.id,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "same.txt",
            newPath: "same.txt",
          });
          assert.equal(contents.newContents, "working\n");
          const mismatch = yield* service
            .getDiffFileContents({
              cwd: meta,
              threadId,
              repositoryId: externalEntry.repository.id,
              sourceKind: "working-tree",
              changeType: "change",
              baseRef: "HEAD",
              headRef: null,
              oldPath: "same.txt",
              newPath: "same.txt",
            })
            .pipe(Effect.flip);
          assert.equal(mismatch._tag, "VcsRepositoryDetectionError");
          yield* fs.remove(path.join(meta, "two", ".git"), { recursive: true });
          const partial = yield* service.getDiffPreview({ cwd: meta, threadId });
          assert.ok(partial.repositories!.find((entry) => entry.repository.name === "Two")!.error);
          assert.isFalse(
            Boolean(
              partial.repositories!.find((entry) => entry.repository.name === "External")!.error,
            ),
          );
        }).pipe(Effect.provide(reviewLayer));
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
