import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadDiffPanelRepositoryId,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      repositoryIdByThreadKey: {},
    }),
  );

  it("defaults each thread to Uncommitted without requiring git status", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });
  });

  it("defaults to Uncommitted before a thread is selected", () => {
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, null)).toEqual({
      kind: "unstaged",
    });
  });

  it("keeps a custom base when a generic open selects Changes again", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectGitScope(THREAD_REF, "branch");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"));
    store.selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("preserves an explicit branch selection", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("clears a thread's turn and file when selecting working tree without changing another thread's branch base", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectBranchBaseRef(otherThreadRef, "origin/main");

    store.selectGitScope(THREAD_REF, "unstaged");

    const { byThreadKey } = useDiffPanelStore.getState();
    expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF)).toEqual({ kind: "unstaged" });
    expect(selectThreadDiffPanelSelection(byThreadKey, otherThreadRef)).toEqual({
      kind: "branch",
      baseRef: "origin/main",
    });

    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = RunId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "turn", turnId, filePath: "src/app.ts", revealRequestId: 2 });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = RunId.make("turn-missing");
    const latestTurnId = RunId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
  });
});

const REPOSITORIES = [{ id: "backend" }, { id: "frontend" }];
const readRepository = (ref = THREAD_REF, repositories = REPOSITORIES) =>
  selectThreadDiffPanelRepositoryId(
    useDiffPanelStore.getState().repositoryIdByThreadKey,
    ref,
    repositories,
  );

describe("workspace repository selection", () => {
  beforeEach(() => useDiffPanelStore.setState({ repositoryIdByThreadKey: {} }));

  it("retains the repository when a new consumer reads after changing diff scopes", () => {
    useDiffPanelStore.getState().selectRepository(THREAD_REF, "backend");
    expect(readRepository()).toBe("backend");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, RunId.make("turn-1"));
    expect(readRepository()).toBe("backend");
  });

  it("isolates selections by environment and thread and removes only the requested thread", () => {
    const otherEnvironment = scopeThreadRef(
      EnvironmentId.make("environment-2"),
      THREAD_REF.threadId,
    );
    const otherThread = scopeThreadRef(THREAD_REF.environmentId, ThreadId.make("thread-2"));
    const store = useDiffPanelStore.getState();
    store.selectRepository(THREAD_REF, "backend");
    store.selectRepository(otherEnvironment, "frontend");
    store.selectRepository(otherThread, "backend");
    expect(readRepository(THREAD_REF)).toBe("backend");
    expect(readRepository(otherEnvironment)).toBe("frontend");
    expect(readRepository(otherThread)).toBe("backend");
    store.removeThread(THREAD_REF);
    expect(readRepository()).toBeNull();
    expect(readRepository(otherEnvironment)).toBe("frontend");
    expect(readRepository(otherThread)).toBe("backend");
  });

  it("falls back to All when the selected repository is absent from the workspace", () => {
    useDiffPanelStore.getState().selectRepository(THREAD_REF, "backend");
    expect(readRepository(THREAD_REF, [{ id: "frontend" }])).toBeNull();
    expect(readRepository(THREAD_REF, [])).toBeNull();
    useDiffPanelStore.getState().selectRepository(THREAD_REF, null);
    expect(readRepository()).toBeNull();
  });

  it("persists and rehydrates a repository and an explicit All selection", async () => {
    const storage = useDiffPanelStore.persist.getOptions().storage!;
    const name = useDiffPanelStore.persist.getOptions().name!;
    for (const repositoryId of ["backend", null]) {
      useDiffPanelStore.getState().selectRepository(THREAD_REF, repositoryId);
      const persisted = await storage.getItem(name);
      useDiffPanelStore.setState({ repositoryIdByThreadKey: {} });
      await storage.setItem(name, persisted!);
      await useDiffPanelStore.persist.rehydrate();
      expect(readRepository()).toBe(repositoryId);
    }
  });

  it("hydrates existing version 2 state without losing scope or branch base", async () => {
    const options = useDiffPanelStore.persist.getOptions();
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/release");
    const { byThreadKey, branchBaseRefByThreadKey } = useDiffPanelStore.getState();
    await options.storage!.setItem(options.name!, {
      version: 2,
      state: { byThreadKey, branchBaseRefByThreadKey },
    });
    await useDiffPanelStore.persist.rehydrate();
    expect(readRepository()).toBeNull();
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "branch",
      baseRef: "origin/release",
    });
  });
});
