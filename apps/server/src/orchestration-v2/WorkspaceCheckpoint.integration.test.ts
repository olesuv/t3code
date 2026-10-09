import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as CodeWorkspaceLoader from "../project/CodeWorkspaceLoader.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

it.effect(
  "recovers partial workspace snapshots after restart without recapturing healthy repositories",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-checkpoint-" });
      const root = yield* fs.realPath(temporary);
      const meta = path.join(root, "meta");
      const external = path.join(root, "external");
      const dependencies = Layer.mergeAll(
        GitVcsDriver.layer,
        VcsProcess.layer,
        ProcessRunner.layer,
        ServerSettings.layerTest(),
        IdAllocator.layer,
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(meta, path.join(root, "state"))),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const run = (cwd: string, args: readonly string[]) =>
          git.execute({ operation: "workspace.checkpoint.fixture", cwd, args });
        const checkouts = [meta, path.join(meta, "one"), path.join(meta, "two"), external];
        for (const cwd of checkouts) {
          yield* fs.makeDirectory(cwd, { recursive: true });
          yield* run(cwd, ["init", "-b", "main"]);
          yield* run(cwd, ["config", "user.name", "Test"]);
          yield* run(cwd, ["config", "user.email", "test@example.com"]);
          yield* fs.writeFileString(path.join(cwd, "same.txt"), "before\n");
          yield* run(cwd, ["add", "same.txt"]);
          yield* run(cwd, ["commit", "-m", "initial"]);
        }
        yield* fs.makeDirectory(path.join(meta, "notes"));
        const filePath = path.join(meta, "team.code-workspace");
        yield* fs.writeFileString(
          filePath,
          JSON.stringify({
            folders: [{ path: "one" }, { path: "two" }, { path: external }, { path: "notes" }],
          }),
        );
        const { workspace } = yield* CodeWorkspaceLoader.CodeWorkspaceLoader.use((loader) =>
          loader.load(filePath),
        ).pipe(Effect.provide(CodeWorkspaceLoader.layer));
        const scope: OrchestrationV2CheckpointScope = {
          id: CheckpointScopeId.make("workspace-restart"),
          threadId: ThreadId.make("workspace-restart"),
          runId: RunId.make("workspace-restart"),
          nodeId: NodeId.make("workspace-restart"),
          providerThreadId: null,
          parentScopeId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: meta,
          createdAt: DateTime.makeUnsafe("2026-10-09T00:00:00Z"),
          workspaceRepositories: workspace.repositories,
        };
        const storage = CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer));
        const freshService = () => CheckpointService.layer.pipe(Layer.provide(storage));
        const baseline = yield* Effect.gen(function* () {
          const service = yield* CheckpointService.CheckpointServiceV2;
          yield* service.captureBaseline({ scope, ordinalWithinScope: 0 });
          return yield* service.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 0 });
        }).pipe(Effect.provide(freshService()));
        assert.equal(baseline.status, "ready");
        assert.equal(baseline.repositories?.length, 4);
        for (const cwd of checkouts)
          yield* fs.writeFileString(path.join(cwd, "same.txt"), "after\n");
        yield* fs.rename(path.join(external, ".git"), path.join(external, ".git-off"));
        const input = {
          scope,
          runId: scope.runId,
          nodeId: scope.nodeId,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
        };
        const partial = yield* CheckpointService.CheckpointServiceV2.use((service) =>
          service.capture(input),
        ).pipe(Effect.provide(freshService()));
        assert.equal(partial.status, "partial");
        assert.equal(partial.repositories?.filter((entry) => entry.status === "ready").length, 3);
        yield* fs.rename(path.join(external, ".git-off"), path.join(external, ".git"));
        yield* fs.writeFileString(path.join(meta, "same.txt"), "changed after capture\n");
        const recovered = yield* CheckpointService.CheckpointServiceV2.use((service) =>
          service.capture(input),
        ).pipe(Effect.provide(freshService()));
        assert.equal(recovered.status, "ready");
        assert.equal(recovered.ordinalWithinScope, 1);
        const metaEntry = recovered.repositories!.find(
          (entry) => entry.repository.checkoutPath === meta,
        )!;
        const metaTree = yield* run(meta, ["ls-tree", "-r", "--name-only", metaEntry.ref]);
        assert.notInclude(metaTree.stdout, "one/");
        assert.notInclude(metaTree.stdout, "two/");
        const metaContents = yield* run(meta, ["show", `${metaEntry.ref}:same.txt`]);
        assert.equal(metaContents.stdout.trim(), "after");
        assert.equal((yield* run(meta, ["diff", "--cached", "--name-only"])).stdout, "");
        const queries = CheckpointDiffQuery.layer.pipe(
          Layer.provide(storage),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getCheckpointContext: () =>
                Effect.succeed({
                  runs: [{ id: scope.runId!, ordinal: 1, status: "completed" }],
                  checkpointScopes: [scope],
                  checkpoints: [baseline, recovered],
                }),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
          const grouped = yield* query.getTurnDiff({
            threadId: scope.threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
          assert.equal(grouped.diff, "");
          assert.equal(grouped.repositories?.length, 4);
          assert.isTrue(
            grouped.repositories!.every((entry) =>
              entry.files.some(
                (file) => file.path === "same.txt" && file.repositoryId === entry.repository.id,
              ),
            ),
          );
          const full = yield* query.getFullThreadDiff({
            threadId: scope.threadId,
            toTurnCount: 1,
            repositoryId: metaEntry.repository.id,
          });
          assert.equal(full.repositories?.length, 1);
          assert.include(full.repositories![0]!.diff!, "+after");
          assert.notInclude(full.repositories![0]!.diff!, "changed after capture");
        }).pipe(Effect.provide(queries));
        yield* Effect.gen(function* () {
          const service = yield* CheckpointService.CheckpointServiceV2;
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(service.restore({ scope, checkpoint: recovered }))),
          );
          assert.equal(
            yield* fs.readFileString(path.join(meta, "same.txt")),
            "changed after capture\n",
          );
          yield* service.deleteStaleRefs({ scope, checkpoints: [baseline, recovered] });
        }).pipe(Effect.provide(freshService()));
        for (const entry of recovered.repositories!) {
          const refs = yield* run(entry.repository.checkoutPath, [
            "for-each-ref",
            "--format=%(refname)",
            entry.ref,
          ]);
          assert.equal(refs.stdout, "");
        }
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
