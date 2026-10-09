import {
  type CodeWorkspace,
  type WorkspaceRepository,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  shell: { branch: "main" } as { branch: string; workspace?: CodeWorkspace } | null,
  repository: null as WorkspaceRepository | null,
  actionCwd: null as string | null,
  detail: null as { branch: string } | null,
  draft: null as { branch: string; worktreePath: null; envMode: "local" } | null,
  branch: "main",
  commits: 0,
  metadataRequests: [] as { environmentId: string; branch: string }[],
  afterGitAction: undefined as (() => void) | undefined,
  run: null as ((input: { action: "commit"; featureBranch?: boolean }) => Promise<void>) | null,
}));

vi.mock("../hooks/useWorkspaceRepository", () => ({
  useWorkspaceRepository: () => ({ repository: state.repository }),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
  useEffectEvent: (callback: typeof state.run) => {
    state.run = callback;
    return callback;
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "vcs-state" ? { isRunning: false } : null),
}));
vi.mock("~/state/entities", () => ({
  useProject: () => null,
  useThreadProjection: (ref: unknown) =>
    ref === null || state.detail === null ? null : { projection: { thread: state.detail } },
  useThreadShell: () => state.shell,
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("~/state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: () => null },
  vcsActionManager: { stateAtom: () => "vcs-state" },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    updateMetadata: async ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { branch: string };
    }) => {
      state.metadataRequests.push({ environmentId, branch: input.branch });
      if (!state.scopes.has(AuthOrchestrationOperateScope))
        return AsyncResult.failure(Cause.fail(new Error("Task denied")));
      if (state.shell) state.shell.branch = input.branch;
      if (state.detail) state.detail.branch = input.branch;
      return AsyncResult.success(undefined);
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      isRepo: true,
      refName: "main",
      isDefaultRef: false,
      hasPrimaryRemote: true,
      hasWorkingTreeChanges: true,
      workingTree: { files: [{ path: "file.ts", status: "modified" }] },
    },
    error: null,
  }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: {
      getDraftSession: () => typeof state.draft;
      getDraftThreadByRef: () => typeof state.draft;
      setDraftThreadContext: (_target: unknown, input: { branch: string }) => void;
    }) => unknown,
  ) =>
    select({
      getDraftSession: () => state.draft,
      getDraftThreadByRef: () => state.draft,
      setDraftThreadContext: (_target, input) => {
        if (state.draft) state.draft.branch = input.branch;
      },
    }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({}),
  useVcsPullAction: () => ({}),
  useSourceControlPublishRepositoryAction: () => ({}),
  useGitStackedAction: (target: { cwd: string | null }) => {
    state.actionCwd = target.cwd;
    return {
      run: async ({ featureBranch }: { featureBranch?: boolean }) => {
        state.commits += 1;
        if (featureBranch) state.branch = "feature";
        state.afterGitAction?.();
        return {
          _tag: "Success",
          value: {
            branch: featureBranch
              ? { status: "created", name: "feature" }
              : { status: "skipped_not_requested" },
            toast: { title: "Committed", description: "Committed", cta: { kind: "none" } },
          },
        };
      },
    };
  },
}));
vi.mock("~/lib/utils", () => ({ cn: () => "", randomUUID: () => "action" }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => () => {} }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => {} }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: () => "toast", update: () => {}, close: () => {} },
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: "Dialog",
  DialogDescription: "DialogDescription",
  DialogFooter: "DialogFooter",
  DialogHeader: "DialogHeader",
  DialogPanel: "DialogPanel",
  DialogPopup: "DialogPopup",
  DialogTitle: "DialogTitle",
}));
vi.mock("~/components/ui/group", () => ({ Group: "Group", GroupSeparator: "GroupSeparator" }));
vi.mock("~/components/ui/menu", () => ({
  Menu: "Menu",
  MenuItem: "MenuItem",
  MenuItemLabel: "MenuItemLabel",
  MenuPopup: "MenuPopup",
  MenuTrigger: "MenuTrigger",
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: "Popover",
  PopoverPopup: "PopoverPopup",
  PopoverTrigger: "PopoverTrigger",
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: "Tooltip",
  TooltipPopup: "TooltipPopup",
  TooltipTrigger: "TooltipTrigger",
}));
vi.mock("~/components/ui/button", () => ({ Button: "Button" }));
vi.mock("~/components/ui/checkbox", () => ({ Checkbox: "Checkbox" }));
vi.mock("~/components/ui/input", () => ({ Input: "Input" }));
vi.mock("~/components/ui/radio-group", () => ({ RadioGroup: "RadioGroup" }));
vi.mock("~/components/ui/scroll-area", () => ({ ScrollArea: "ScrollArea" }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: "Spinner" }));
vi.mock("~/components/ui/textarea", () => ({ Textarea: "Textarea" }));
vi.mock("~/components/ui/toggle", () => ({ toggleVariants: () => "" }));
vi.mock("./AnimatedHeight", () => ({ AnimatedHeight: "AnimatedHeight" }));

import GitActionsControl from "./GitActionsControl";

function renderActions() {
  GitActionsControl({
    gitCwd: "/repo",
    activeThreadRef: {
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    },
  });
  if (!state.run) throw new Error("Git action missing");
  return state.run;
}

describe("Git actions while thread details load", () => {
  beforeEach(() => {
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
    state.shell = { branch: "main" };
    state.repository = null;
    state.actionCwd = null;
    state.detail = null;
    state.draft = null;
    state.branch = "main";
    state.commits = 0;
    state.metadataRequests = [];
    state.afterGitAction = undefined;
    state.run = null;
  });

  it("does not create a feature branch for a server thread without task permission", async () => {
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.branch).toBe("main");
    expect(state.commits).toBe(0);
    expect(state.shell?.branch).toBe("main");
  });

  it("commits and synchronizes the server thread before details finish loading", async () => {
    state.primaryScopes.clear();
    state.scopes.add(AuthOrchestrationOperateScope);
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.branch).toBe("feature");
    expect(state.commits).toBe(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("synchronizes archived thread detail after its shell disappears", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "main" };
    renderActions();
    state.shell = null;

    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(1);
    expect(state.branch).toBe("feature");
    expect(state.detail.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("requires task permission before changing an archived thread's branch", async () => {
    state.shell = null;
    state.detail = { branch: "main" };

    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(0);
    expect(state.detail.branch).toBe("main");
    expect(state.metadataRequests).toEqual([]);
  });

  it("uses the current shell branch when cached detail names the new branch", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "feature" };

    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("synchronizes a retained callback after the thread grant is gained", async () => {
    const run = renderActions();
    state.scopes.add(AuthOrchestrationOperateScope);
    await run({ action: "commit", featureBranch: true });
    expect(state.commits).toBe(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toHaveLength(1);
  });

  it.each([
    [AuthOrchestrationOperateScope, false],
    [AuthSourceControlWriteScope, true],
  ] as const)(
    "uses the fresh task grant after Git finishes, revoking %s",
    async (revokedScope, syncsThread) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(revokedScope);
      await renderActions()({ action: "commit", featureBranch: true });
      expect(state.commits).toBe(1);
      expect(state.branch).toBe("feature");
      expect(state.shell?.branch).toBe(syncsThread ? "feature" : "main");
      expect(state.metadataRequests).toHaveLength(syncsThread ? 1 : 0);
    },
  );

  it("keeps ordinary commits available while details load", async () => {
    await renderActions()({ action: "commit" });

    expect(state.commits).toBe(1);
    expect(state.branch).toBe("main");
  });

  it("keeps feature-branch commits available for a local draft", async () => {
    state.shell = null;
    state.draft = { branch: "main", worktreePath: null, envMode: "local" };
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(1);
    expect(state.draft.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([]);
  });
});

describe("workspace Git targets", () => {
  const workspace: CodeWorkspace = {
    filePath: "/meta/team.code-workspace",
    workspaceRoot: "/meta",
    folders: [],
    repositories: [{ id: "external", name: "External", checkoutPath: "/external" }],
  };
  it("does not commit without an explicitly selected workspace repository", async () => {
    state.shell = { branch: "main", workspace };
    state.repository = null;
    state.commits = 0;
    await renderActions()({ action: "commit" });
    expect(state.actionCwd).toBeNull();
    expect(state.commits).toBe(0);
  });
  it("commits in the selected checkout without overwriting the thread's single branch metadata", async () => {
    state.scopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
    state.shell = { branch: "main", workspace };
    state.repository = workspace.repositories[0]!;
    state.commits = 0;
    state.metadataRequests = [];
    await renderActions()({ action: "commit", featureBranch: true });
    expect(state.actionCwd).toBe("/external");
    expect(state.commits).toBe(1);
    expect(state.metadataRequests).toEqual([]);
  });
});
