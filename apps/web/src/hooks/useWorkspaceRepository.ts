import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { CodeWorkspace, ScopedThreadRef } from "@t3tools/contracts";
import { workspaceRepositorySelectionAtom } from "@t3tools/client-runtime/state/vcs";

export function useWorkspaceRepository(
  threadRef: ScopedThreadRef | null,
  workspace: CodeWorkspace | null | undefined,
) {
  const atom = workspaceRepositorySelectionAtom(
    JSON.stringify([threadRef?.environmentId, threadRef?.threadId]),
  );
  const repositoryId = useAtomValue(atom);
  const selectRepository = useAtomSet(atom);
  return {
    repository: workspace?.repositories.find((entry) => entry.id === repositoryId) ?? null,
    selectRepository,
  };
}
