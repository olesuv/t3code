import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type CodeWorkspace,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("refreshes workspace after checkpoint capture without reading history", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const checkpointContext = {
    runs: [],
    checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
    checkpoints: [],
  };
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("workspace refresh must not load transcript history"),
          getCheckpointContext: () => Effect.succeed(checkpointContext),
          getThreadShell: () => Effect.succeed(null),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], [{ cwd: "/repo", threadId, runId }]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
      {
        label: "refreshes a workspace repository on its own branch",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: ["/repo"],
        workspace: true,
      },
      {
        label: "keeps the stale run guard for workspace repositories",
        branch: "feature",
        checkedOut: "other",
        activeRun: "newer-run",
        expected: [],
        workspace: true,
      },
      {
        label: "keeps branch checks for workspace worktrees",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
        workspace: true,
        worktree: true,
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              workspace: "workspace" in scenario ? workspace : null,
              worktreePath: "worktree" in scenario ? "/worktree" : null,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({
      cwd: "/repo",
      threadId,
      runId,
      workspaceRepository: "workspace" in scenario,
    });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

const workspace: CodeWorkspace = {
  filePath: "/workspace/project.code-workspace",
  workspaceRoot: "/workspace",
  folders: [
    { id: "child", name: "Child", path: "/workspace/child" },
    { id: "plain", name: "Plain", path: "/plain" },
    { id: "missing", name: "Missing", path: "/missing" },
  ],
  repositories: [
    { id: "child", name: "Child", checkoutPath: "/workspace/child" },
    { id: "external", name: "External", checkoutPath: "/external" },
  ],
};

it.effect("refreshes deduplicated frozen workspace roots despite a missing root", () => {
  const threadId = ThreadId.make("workspace-thread");
  const runId = RunId.make("workspace-run");
  const scopeId = CheckpointScopeId.make("workspace-scope");
  const refreshed: Array<{ cwd: string; refreshGit?: boolean }> = [];
  let captured = false;
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.sync(() => {
              captured = true;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.die("must not load transcript history"),
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpoints: [],
              checkpointScopes: [
                {
                  id: scopeId,
                  runId,
                  kind: "root_run" as const,
                  cwd: "/workspace",
                },
              ],
            }),
          getThreadShell: () =>
            Effect.succeed({ workspace, worktreePath: null } as OrchestrationV2ThreadShell),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refreshAfterTurn: () => Effect.void,
          refresh: (input) =>
            Effect.gen(function* () {
              assert.isTrue(captured);
              refreshed.push(input);
              if (input.cwd === "/missing")
                return yield* new RunFinalization.RunFinalizationRefreshError({
                  cwd: input.cwd,
                  cause: new Error("missing"),
                });
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.deepEqual(
      refreshed
        .map(({ cwd, refreshGit }) => ({ cwd, refreshGit }))
        .sort((a, b) => a.cwd.localeCompare(b.cwd)),
      [
        { cwd: "/external", refreshGit: true },
        { cwd: "/missing", refreshGit: false },
        { cwd: "/plain", refreshGit: false },
        { cwd: "/workspace", refreshGit: false },
        { cwd: "/workspace/child", refreshGit: true },
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("refreshes plain file roots without requesting Git status", () => {
  const refreshed: string[] = [];
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({
          refresh: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () => Effect.die("plain roots must not request Git status"),
          refreshPullRequestStatus: () => Effect.die("plain roots must not request PR status"),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.die("plain file refresh does not need a thread"),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({
      cwd: "/plain",
      threadId: ThreadId.make("plain-thread"),
      runId: RunId.make("plain-run"),
      refreshGit: false,
    });
    assert.deepEqual(refreshed, ["/plain"]);
  }).pipe(Effect.provide(layer));
});
