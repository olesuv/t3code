import { AtomRegistry } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { CodeWorkspace } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  thread: { id: "thread", environmentId: "remote", workspace: null as CodeWorkspace | null },
}));
const registry = AtomRegistry.make();
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Parameters<typeof registry.get>[0]) => registry.get(atom),
  useAtomSet: (atom: Parameters<typeof registry.set>[0]) => (value: string | null) =>
    registry.set(atom, value),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: state.thread }),
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/execution",
    selectedThreadWorktreePath: null,
  }),
}));

import { useSelectedThreadGitCwd } from "./use-selected-thread-git-cwd";

beforeEach(() => {
  registry.reset();
  state.thread = {
    id: "thread",
    environmentId: "remote",
    workspace: {
      filePath: "/execution/team.code-workspace",
      workspaceRoot: "/execution",
      folders: [],
      repositories: [
        { id: "meta", name: "Meta", checkoutPath: "/execution" },
        { id: "external", name: "External", checkoutPath: "/external" },
      ],
    },
  };
});

it("requires explicit repository selection and scopes it to the destination environment and thread", () => {
  expect(useSelectedThreadGitCwd().selectedThreadCwd).toBeNull();
  useSelectedThreadGitCwd().selectRepository("external");
  expect(useSelectedThreadGitCwd().selectedThreadCwd).toBe("/external");
  state.thread.environmentId = "local";
  expect(useSelectedThreadGitCwd().selectedThreadCwd).toBeNull();
  state.thread.environmentId = "remote";
  state.thread.id = "another-thread";
  expect(useSelectedThreadGitCwd().selectedThreadCwd).toBeNull();
  state.thread.id = "thread";
  expect(useSelectedThreadGitCwd().selectedThreadCwd).toBe("/external");
});

it("rejects an unavailable frozen repository identity and preserves ordinary directory behavior", () => {
  useSelectedThreadGitCwd().selectRepository("not-a-repository");
  expect(useSelectedThreadGitCwd().selectedThreadCwd).toBeNull();
  state.thread.workspace = null;
  expect(useSelectedThreadGitCwd().selectedThreadCwd).toBe("/execution");
});
