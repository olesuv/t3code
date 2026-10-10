import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodePath.layer)),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        yield* CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("keeps workspace captures independent, idempotent, and repository-qualified", () => {
  const scope: OrchestrationV2CheckpointScope = {
    id: CheckpointScopeId.make("workspace-scope"),
    threadId: ThreadId.make("workspace-thread"),
    runId: RunId.make("workspace-run"),
    nodeId: NodeId.make("workspace-node"),
    providerThreadId: ProviderThreadId.make("workspace-provider-thread"),
    parentScopeId: null,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/meta",
    createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    workspaceRepositories: [
      { id: "meta", name: "Meta", checkoutPath: "/meta" },
      { id: "child", name: "Child", checkoutPath: "/meta/child" },
      { id: "external", name: "External", checkoutPath: "/external" },
    ],
  };
  const refs = new Set<string>();
  let failExternal = true;
  let failDiff = false;
  const captureCheckpoint = vi.fn((input: CheckpointStore.CaptureCheckpointInput) => {
    if (failExternal && input.cwd === "/external") {
      return Effect.fail(
        new VcsProcessTimeoutError({
          operation: "capture",
          command: "git",
          cwd: input.cwd,
          timeoutMs: 1,
        }),
      );
    }
    refs.add(`${input.cwd}:${input.checkpointRef}`);
    return Effect.void;
  });
  const deleteCheckpointRefs = vi.fn((input: CheckpointStore.DeleteCheckpointRefsInput) =>
    Effect.sync(() => {
      for (const ref of input.checkpointRefs) refs.delete(`${input.cwd}:${ref}`);
    }),
  );
  const testLayer = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          hasCheckpointRef: (input) =>
            Effect.succeed(refs.has(`${input.cwd}:${input.checkpointRef}`)),
          captureCheckpoint,
          diffCheckpoints: (input) =>
            failDiff && input.cwd === "/meta/child"
              ? Effect.fail(
                  new VcsProcessTimeoutError({
                    operation: "diff",
                    command: "git",
                    cwd: input.cwd,
                    timeoutMs: 1,
                  }),
                )
              : Effect.succeed("1\t2\tsame.txt\0"),
          deleteCheckpointRefs,
        }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodePath.layer)),
  );
  return Effect.gen(function* () {
    const service = yield* CheckpointService.CheckpointServiceV2;
    yield* service.captureBaseline({ scope, ordinalWithinScope: 0 });
    const baseline = yield* service.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 0 });
    assert.equal(baseline.status, "partial");
    assert.deepEqual(
      baseline.repositories?.map((entry) => entry.status),
      ["ready", "ready", "missing"],
    );
    assert.deepEqual(captureCheckpoint.mock.calls[0]?.[0].excludePaths, ["child"]);
    const captureInput = {
      scope,
      runId: scope.runId,
      nodeId: scope.nodeId,
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      capturedAt: scope.createdAt,
    };
    const first = yield* service.capture(captureInput);
    assert.equal(first.status, "partial");
    assert.deepEqual(
      first.files.map((file) => [file.repositoryId, file.path]),
      [
        ["meta", "same.txt"],
        ["child", "same.txt"],
      ],
    );
    assert.equal(first.repositories?.[2]?.status, "error");
    const successfulRefs = first.repositories?.slice(0, 2).map((entry) => entry.ref);
    failExternal = false;
    const retried = yield* service.capture(captureInput);
    assert.deepEqual(
      retried.repositories?.slice(0, 2).map((entry) => entry.ref),
      successfulRefs,
    );
    assert.equal(
      captureCheckpoint.mock.calls.filter(([input]) => input.checkpointRef === successfulRefs?.[0])
        .length,
      1,
    );
    assert.equal(retried.repositories?.[2]?.summaryError, "baseline-missing");
    assert.equal(retried.status, "partial");
    failDiff = true;
    const next = yield* service.capture({ ...captureInput, ordinalWithinScope: 2 });
    assert.equal(next.repositories?.[1]?.summaryError, "diff-failed");
    assert.equal(next.status, "partial");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(service.restore({ scope, checkpoint: next }))));
    yield* service.deleteStaleRefs({ scope, checkpoints: [baseline, retried, next] });
    assert.deepEqual(deleteCheckpointRefs.mock.calls.map(([input]) => input.cwd).sort(), [
      "/external",
      "/meta",
      "/meta/child",
    ]);
    assert.equal(refs.size, 0);
  }).pipe(Effect.provide(testLayer));
});
