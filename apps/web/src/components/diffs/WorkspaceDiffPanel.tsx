import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { WorkspaceRepository } from "@t3tools/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useWorkspaceMutationRefresh } from "../../hooks/useWorkspaceMutationRefresh";
import type { DraftId } from "../../composerDraftStore";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../../diffPanelStore";
import { useCheckpointDiff } from "../../lib/checkpointDiffState";
import { useThreadProjection } from "../../state/entities";
import { useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DiffPanelLoadingState, type DiffPanelMode } from "../DiffPanelShell";

/** Repository groups carry their own file namespace; patches load after selection. */
export function WorkspaceDiffPanel(props: {
  readonly thread: EnvironmentThreadShell;
  readonly mode?: DiffPanelMode;
  readonly composerDraftTarget: ReturnType<typeof scopeThreadRef> | DraftId;
  readonly workspaceMutationId: string | null;
  readonly renderRepository: (
    repository: WorkspaceRepository,
    fullThread: boolean,
    clearFullThread: () => void,
  ) => ReactNode;
}) {
  const workspace = props.thread.workspace!;
  const threadRef = useMemo(
    () => scopeThreadRef(props.thread.environmentId, props.thread.id),
    [props.thread.environmentId, props.thread.id],
  );
  const [fullThread, setFullThread] = useState(false);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const selection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, threadRef),
  );
  const projection = useThreadProjection(threadRef)?.projection;
  const turns = (projection?.checkpoints ?? [])
    .filter((entry) => entry.appRunOrdinal !== null && entry.runId !== null)
    .toSorted((a, b) => b.appRunOrdinal! - a.appRunOrdinal!);
  const turn =
    fullThread || selection.kind === "turn"
      ? (turns.find(
          (entry) =>
            entry.runId === (selection.kind === "turn" ? selection.turnId : turns[0]?.runId),
        ) ?? turns[0])
      : null;
  const fileAccess = useFilesystemReadAccess(props.thread.environmentId);
  const repository = workspace.repositories.find((entry) => entry.id === repositoryId);
  const preview = useEnvironmentQuery(
    !repository && !turn && fileAccess.canReadFiles
      ? reviewEnvironment.diffPreview({
          environmentId: props.thread.environmentId,
          input: { threadId: props.thread.id, cwd: workspace.workspaceRoot },
        })
      : null,
  );
  const history = useCheckpointDiff(
    {
      environmentId: props.thread.environmentId,
      threadId: props.thread.id,
      fromTurnCount: turn ? (fullThread ? 0 : Math.max(0, turn.appRunOrdinal! - 1)) : null,
      toTurnCount: turn?.appRunOrdinal ?? null,
      ignoreWhitespace: true,
    },
    { enabled: !repository && turn !== null && fileAccess.canReadFiles },
  );
  const scope = fullThread
    ? "thread"
    : selection.kind === "turn" && turn
      ? `turn:${turn.runId}`
      : selection.kind === "unstaged"
        ? "unstaged"
        : "branch";
  const groups = turn
    ? history.data?.repositories?.map((entry) => ({
        repository: entry.repository,
        error: entry.error,
        incomplete: false,
        files: entry.files,
      }))
    : preview.data?.repositories?.map((entry) => ({
        repository: entry.repository,
        error: entry.error,
        incomplete: entry.sources.some((source) => source.truncated),
        files:
          entry.sources.find(
            (source) => source.kind === (scope === "unstaged" ? "working-tree" : "branch-range"),
          )?.files ?? [],
      }));
  const error = turn ? history.error : preview.error;
  const pending = turn ? history.isPending : preview.isPending;

  const canRefresh = !repository && !turn && fileAccess.canReadFiles;
  const refreshPreview = preview.refresh;
  useEffect(() => {
    if (!canRefresh) return;
    const refresh = () => refreshPreview();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [canRefresh, refreshPreview]);
  useWorkspaceMutationRefresh({
    enabled: canRefresh,
    mutationId: props.workspaceMutationId,
    refresh: preview.refresh,
    resourceKey: `workspace-diff:${props.thread.environmentId}:${props.thread.id}`,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Select
          value={repository?.id ?? "all"}
          onValueChange={(value) => setRepositoryId(value === "all" ? null : value)}
        >
          <SelectTrigger size="sm" aria-label="Diff repository">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All repositories</SelectItem>
            {workspace.repositories.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {
          <Select
            value={scope}
            onValueChange={(value) => {
              setFullThread(value === "thread");
              if (value === "branch" || value === "unstaged")
                useDiffPanelStore.getState().selectGitScope(threadRef, value);
              else {
                const selected = turns.find((entry) => `turn:${entry.runId}` === value);
                if (selected?.runId)
                  useDiffPanelStore.getState().selectTurn(threadRef, selected.runId);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Diff scope">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="branch">Changes</SelectItem>
              <SelectItem value="unstaged">Uncommitted</SelectItem>
              {turns.length > 0 ? <SelectItem value="thread">Full thread</SelectItem> : null}
              {turns.map((entry) => (
                <SelectItem key={entry.id} value={`turn:${entry.runId}`}>
                  Turn {entry.appRunOrdinal}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      </div>
      {repository ? (
        <div className="min-h-0 flex-1">
          {props.renderRepository(repository, fullThread, () => setFullThread(false))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {fileAccess.isPending || pending ? (
            <DiffPanelLoadingState label="Loading repository changes…" />
          ) : !fileAccess.canReadFiles ? (
            <p>File access is required to review workspace changes.</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : null}
          {fileAccess.canReadFiles &&
            groups?.map((group) => (
              <section key={group.repository.id} className="mb-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRepositoryId(group.repository.id)}
                >
                  {group.repository.name}
                </Button>
                <p className="px-3 text-xs text-muted-foreground">
                  {group.repository.checkoutPath}
                </p>
                {group.error ? (
                  <p role="alert" className="px-3 py-2 text-sm">
                    {group.error}
                  </p>
                ) : group.incomplete ? (
                  <p className="px-3 py-2 text-sm">
                    Summary incomplete. Select this repository to load changes.
                  </p>
                ) : group.files.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">No changes</p>
                ) : (
                  <ul>
                    {group.files.map((file) => (
                      <li
                        key={JSON.stringify([
                          props.thread.environmentId,
                          group.repository.id,
                          file.path,
                        ])}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRepositoryId(group.repository.id)}
                        >
                          {file.path} · +{file.additions} −{file.deletions}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          {workspace.repositories.length === 0 ? (
            <p className="text-sm text-muted-foreground">This workspace has no Git repositories.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
