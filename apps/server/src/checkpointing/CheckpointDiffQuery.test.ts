import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  VcsProcessTimeoutError,
  CheckpointRef,
  CheckpointScopeId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/t3/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function layerFor(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
}

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = layerFor({ projection: Effect.succeed(makeProjection()), diffCheckpoints });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: yield* checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = layerFor({
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointThreadNotFoundError);
    assert.deepEqual(
      { operation: error.operation, threadId: error.threadId },
      { operation: "CheckpointDiffQuery.getTurnDiff", threadId },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed unavailable-range error contract", () => {
  const layer = layerFor({ projection: Effect.succeed(makeProjection()) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 3 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 3, availableTurnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: projection.checkpointScopes.map((scope) => ({
        ...scope,
        kind: "tool" as const,
      })),
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 0 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "returns workspace summaries independently and fetches only the selected repository patch",
  () => {
    const projection = makeProjection();
    const meta = { id: "meta", name: "Meta", checkoutPath: "/meta" };
    const child = { id: "child", name: "Child", checkoutPath: "/meta/child" };
    const external = { id: "external", name: "External", checkoutPath: "/external" };
    const baselineRef = CheckpointRef.make("refs/t3/test/baseline");
    const entries = [meta, child, external].map((repository) => ({
      repository,
      ref: secondRef,
      status: "ready" as const,
      files: [],
    }));
    const workspaceProjection: ProjectionCheckpointContext = {
      ...projection,
      checkpoints: [
        {
          scopeId: secondScopeId,
          runId: null,
          appRunOrdinal: null,
          status: "partial",
          ref: baselineRef,
          repositories: entries.map((entry) => ({
            ...entry,
            ref: baselineRef,
            status: entry.repository.id === "external" ? "missing" : "ready",
          })),
        },
        { ...projection.checkpoints[0]!, status: "partial", repositories: entries },
      ],
    };
    const diffCheckpoints = vi.fn((input: CheckpointStore.DiffCheckpointsInput) =>
      input.cwd === child.checkoutPath
        ? Effect.fail(
            new VcsProcessTimeoutError({
              operation: "test",
              command: "git",
              cwd: input.cwd,
              timeoutMs: 1,
            }),
          )
        : Effect.succeed(input.format === "numstat" ? "2\t1\tsame.txt\0" : "meta patch"),
    );
    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
      assert.equal(result.diff, "");
      assert.deepEqual(
        result.repositories?.map((entry) => [entry.repository.id, entry.status]),
        [
          ["meta", "ready"],
          ["child", "error"],
          ["external", "missing"],
        ],
      );
      assert.deepEqual(result.repositories?.[0]?.files, [
        { repositoryId: "meta", path: "same.txt", additions: 2, deletions: 1 },
      ]);
      assert.isTrue(diffCheckpoints.mock.calls.every(([input]) => input.format === "numstat"));
      diffCheckpoints.mockClear();
      const selected = yield* query.getTurnDiff({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 2,
        repositoryId: "meta",
      });
      assert.equal(selected.repositories?.[0]?.diff, "meta patch");
      assert.equal(selected.repositories?.length, 1);
      assert.isTrue(diffCheckpoints.mock.calls.every(([input]) => input.cwd === "/meta"));
    }).pipe(
      Effect.provide(
        layerFor({ projection: Effect.succeed(workspaceProjection), diffCheckpoints }),
      ),
    );
  },
);
