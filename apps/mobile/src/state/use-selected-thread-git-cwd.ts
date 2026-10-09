import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { workspaceRepositorySelectionAtom } from "@t3tools/client-runtime/state/vcs";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";

/** Git actions use a chosen frozen repository; terminals and providers keep their execution root. */
export function useSelectedThreadGitCwd() {
  const { selectedThread } = useThreadSelection();
  const workspace = selectedThread?.workspace;
  const selectionAtom = workspaceRepositorySelectionAtom(
    JSON.stringify([selectedThread?.environmentId, selectedThread?.id]),
  );
  const repositoryId = useAtomValue(selectionAtom);
  const selectRepository = useAtomSet(selectionAtom);
  const repository = workspace?.repositories.find((entry) => entry.id === repositoryId) ?? null;
  const execution = useSelectedThreadWorktree();
  return {
    ...execution,
    repository,
    selectRepository,
    selectedThreadCwd: workspace ? (repository?.checkoutPath ?? null) : execution.selectedThreadCwd,
    selectedThreadWorktreePath: workspace ? null : execution.selectedThreadWorktreePath,
  };
}
