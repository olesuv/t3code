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
import { DiffStatLabel } from "../chat/DiffStatLabel";
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
  const repositoryItems = [
    { value: "all", label: "All repositories" },
    ...workspace.repositories.map((entry) => ({ value: entry.id, label: entry.name })),
  ];
  const scopeItems = [
    { value: "branch", label: "Changes" },
    { value: "unstaged", label: "Uncommitted" },
    ...(turns.length > 0 ? [{ value: "thread", label: "Full thread" }] : []),
    ...turns.map((entry) => ({
      value: `turn:${entry.runId}`,
      label: `Turn ${entry.appRunOrdinal}`,
    })),
  ];

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
          items={repositoryItems}
          value={repository?.id ?? "all"}
          onValueChange={(value) => setRepositoryId(value === "all" ? null : value)}
        >
          <SelectTrigger size="sm" aria-label="Diff repository">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {repositoryItems.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {
          <Select
            items={scopeItems}
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
            <SelectPopup alignItemWithTrigger={false}>
              {scopeItems.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
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
            groups?.map((group) => {
              const totals = group.files.reduce(
                (total, file) => ({
                  additions: total.additions + file.additions,
                  deletions: total.deletions + file.deletions,
                }),
                { additions: 0, deletions: 0 },
              );
              return (
                <button
                  key={group.repository.id}
                  type="button"
                  className="mb-4 flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => setRepositoryId(group.repository.id)}
                >
                  <span className="flex w-full min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {group.repository.name}
                    </span>
                    {!group.error && group.files.length > 0 ? (
                      <DiffStatLabel
                        additions={totals.additions}
                        deletions={totals.deletions}
                        className="shrink-0 text-xs"
                        layout="inline"
                      />
                    ) : null}
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {group.repository.checkoutPath}
                  </span>
                  {group.error ? (
                    <span role="alert" className="text-sm">
                      {group.error}
                    </span>
                  ) : group.incomplete ? (
                    <span className="text-sm text-muted-foreground">
                      Summary incomplete. Select this repository to load changes.
                    </span>
                  ) : null}
                </button>
              );
            })}
          {workspace.repositories.length === 0 ? (
            <p className="text-sm text-muted-foreground">This workspace has no Git repositories.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
