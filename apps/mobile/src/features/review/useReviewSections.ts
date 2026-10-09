import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "../../state/session";
import { useCallback, useEffect, useMemo } from "react";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, ThreadId, WorkspaceRepository } from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { reviewEnvironment } from "../../state/review";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
} from "./reviewModel";
import {
  setReviewAsyncError,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  setReviewTurnDiffLoading,
  type ReviewCacheForThread,
} from "./reviewState";

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
  readonly repository?: WorkspaceRepository;
  readonly fullThread?: boolean;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const enabled = input.enabled ?? true;
  const sectionPrefix = input.repository
    ? `${environmentId}:repository:${input.repository.id}:`
    : "";
  const fileAccessSession = useEnvironmentQuery(
    environmentId === undefined ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd: defaultCwd } = useSelectedThreadWorktree();
  const selectedThreadCwd = input.repository?.checkoutPath ?? defaultCwd;
  const diffPreview = useEnvironmentQuery(
    canReadFiles && enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: {
            cwd: selectedThreadCwd,
            ...(input.repository && threadId
              ? { threadId, repositoryId: input.repository.id }
              : {}),
          },
        })
      : null,
  );
  const { loadingTurnIds } = reviewCache.asyncState;

  useEffect(() => {
    if (reviewCache.threadKey && diffPreview.data) {
      setReviewGitSections(reviewCache.threadKey, diffPreview.data.sources);
    }
  }, [diffPreview.data, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () =>
      getReadyReviewCheckpoints(
        selectedThread === null ? [] : deriveThreadCheckpointSummaries(selectedThread.projection),
      ),
    [selectedThread],
  );
  const checkpointBySectionId = useMemo(
    () =>
      Object.fromEntries(
        readyCheckpoints.map((checkpoint) => [
          `${sectionPrefix}${getReviewSectionIdForCheckpoint(checkpoint)}`,
          checkpoint,
        ]),
      ) as Record<string, ThreadCheckpointSummary>,
    [readyCheckpoints, sectionPrefix],
  );
  const reviewSections = useMemo(() => {
    const sections = buildReviewSectionItems({
      checkpoints: readyCheckpoints,
      gitSections:
        canReadFiles || fileAccess.isPending
          ? (diffPreview.data?.sources ?? reviewCache.gitSections)
          : [],
      turnDiffById: sectionPrefix
        ? Object.fromEntries(
            Object.entries(reviewCache.turnDiffById).map(([id, diff]) => [
              id.startsWith(sectionPrefix) ? id.slice(sectionPrefix.length) : id,
              diff,
            ]),
          )
        : reviewCache.turnDiffById,
      loadingTurnIds: sectionPrefix
        ? Object.fromEntries(
            Object.entries(loadingTurnIds).map(([id, pending]) => [
              id.startsWith(sectionPrefix) ? id.slice(sectionPrefix.length) : id,
              pending,
            ]),
          )
        : loadingTurnIds,
      loadingGitSections: fileAccess.isPending || diffPreview.isPending,
    });
    const qualifiedSections = sectionPrefix
      ? sections.map((section) => ({ ...section, id: `${sectionPrefix}${section.id}` }))
      : sections;
    // Keep the selected section while its grant loads, without displaying cached host files.
    return fileAccess.isPending
      ? qualifiedSections.map((section) =>
          section.kind === "turn" ? section : { ...section, diff: null, isLoading: true },
        )
      : qualifiedSections;
  }, [
    canReadFiles,
    sectionPrefix,
    diffPreview.data?.sources,
    diffPreview.isPending,
    fileAccess.isPending,
    loadingTurnIds,
    readyCheckpoints,
    reviewCache.gitSections,
    reviewCache.turnDiffById,
  ]);
  const selectedSection = useMemo(
    () =>
      reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
      reviewSections[0] ??
      null,
    [reviewCache.selectedSectionId, reviewSections],
  );
  const fallbackSectionId = useMemo(
    () => getDefaultReviewSectionId(reviewSections),
    [reviewSections],
  );
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  useEffect(() => {
    if (
      reviewSections.length > 0 &&
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId || !selectedSectionIdExists)
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    reviewSections.length,
    selectedSectionIdExists,
  ]);

  let activeCheckpoint = readyCheckpoints[0] ?? null;
  if (!input.fullThread && selectedSection?.kind === "turn") {
    activeCheckpoint = checkpointBySectionId[selectedSection.id] ?? activeCheckpoint;
  }
  const activeSectionId = activeCheckpoint
    ? `${sectionPrefix}${getReviewSectionIdForCheckpoint(activeCheckpoint)}`
    : null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && canReadFiles && activeCheckpoint
        ? input.fullThread
          ? 0
          : Math.max(0, activeCheckpoint.checkpointTurnCount - 1)
        : null,
    toTurnCount: enabled ? (activeCheckpoint?.checkpointTurnCount ?? null) : null,
    ignoreWhitespace: false,
    ...(input.repository ? { repositoryId: input.repository.id } : {}),
  });

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId) {
      return;
    }
    setReviewTurnDiffLoading(reviewCache.threadKey, activeSectionId, activeTurnDiff.isPending);
  }, [activeSectionId, activeTurnDiff.isPending, reviewCache.threadKey]);

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId || !activeTurnDiff.data) {
      return;
    }
    const repositoryDiff = input.repository
      ? activeTurnDiff.data.repositories?.find(
          (entry) => entry.repository.id === input.repository!.id,
        )
      : undefined;
    setReviewTurnDiff(
      reviewCache.threadKey,
      activeSectionId,
      repositoryDiff?.diff ?? activeTurnDiff.data.diff,
    );
    setReviewAsyncError(reviewCache.threadKey, repositoryDiff?.error ?? null);
  }, [activeSectionId, activeTurnDiff.data, reviewCache.threadKey, input.repository]);

  useEffect(() => {
    if (reviewCache.threadKey && activeTurnDiff.error) {
      setReviewAsyncError(reviewCache.threadKey, activeTurnDiff.error);
    }
  }, [activeTurnDiff.error, reviewCache.threadKey]);

  const refreshSelectedSection = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    diffPreview.refresh();
  }, [activeTurnDiff, diffPreview, enabled, selectedSection?.kind]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  return {
    error:
      diffPreview.error ??
      activeTurnDiff.error ??
      reviewCache.asyncState.error ??
      (selectedSection === null && !fileAccess.isPending && !canReadFiles
        ? (fileAccess.error ?? "This connection cannot read local diffs.")
        : null),
    isSelectedSectionPending:
      selectedSection?.kind === "turn" ? activeTurnDiff.isPending : diffPreview.isPending,
    loadingGitDiffs: fileAccess.isPending || diffPreview.isPending,
    diffPreviewRevision: diffPreview.data
      ? DateTime.formatIso(diffPreview.data.generatedAt)
      : undefined,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}
