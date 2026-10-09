import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewRepositoryDiff,
  type WorkspaceRepository,
} from "@t3tools/contracts";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: "ReviewService.getDiffPreview" | "ReviewService.getDiffFileContents",
    cwd: string,
  ) {
    const worktreesDirectories = yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ worktreesDirectory: "", previousWorktreesDirectories: [] })),
    );
    const [candidate, workspaceRoot, worktreesRoots] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      // A managed root that cannot be resolved, or resolves to a filesystem
      // root through a symlink, is skipped rather than failing every review.
      Effect.forEach(
        managedWorktreesDirectories(worktreesDirectories, config.worktreesDir, path),
        (directory) => canonicalizePath(directory).pipe(Effect.orElseSucceed(() => null)),
      ).pipe(
        Effect.map((roots) =>
          roots.filter((root): root is string => root !== null && !isFilesystemRoot(root, path)),
        ),
      ),
    ]);

    if (
      isWithinRoot(candidate, workspaceRoot) ||
      worktreesRoots.some((root) => isWithinRoot(candidate, root))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const getWorkspace = (threadId: NonNullable<ReviewDiffPreviewInput["threadId"]>) =>
    projections.getThreadShell(threadId).pipe(
      Effect.flatMap((thread) =>
        thread
          ? Effect.succeed(thread.workspace)
          : Effect.fail(
              new VcsRepositoryDetectionError({
                operation: "ReviewService.workspace",
                cwd: "",
                detail:
                  "This thread no longer exists. Reload the thread before reviewing its files.",
              }),
            ),
      ),
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "ReviewService.workspace",
            cwd: "",
            detail: "Could not read this thread's workspace.",
            cause,
          }),
      ),
    );
  const assertRepository = Effect.fn("ReviewService.assertRepository")(function* (
    repository: WorkspaceRepository,
    cwd: string,
  ) {
    const candidate = yield* canonicalizePath(cwd);
    const handle = yield* vcsRegistry.detect({ cwd: candidate, requestedKind: "git" });
    if (
      candidate !== repository.checkoutPath ||
      !handle ||
      (yield* canonicalizePath(handle.repository.rootPath)) !== repository.checkoutPath
    ) {
      return yield* new VcsRepositoryDetectionError({
        operation: "ReviewService.workspace",
        cwd,
        detail:
          "The selected workspace repository checkout is unavailable or does not match this thread.",
      });
    }
    return handle;
  });

  const getSinglePreview = Effect.fn("ReviewService.getSinglePreview")(function* (
    input: ReviewDiffPreviewInput,
    repository?: WorkspaceRepository,
  ) {
    const handle = repository
      ? yield* assertRepository(repository, input.cwd)
      : yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle)
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      } satisfies ReviewDiffPreviewResult;
    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (getDriverDiffPreview) return yield* getDriverDiffPreview(input);
    if (handle.kind === "git") return yield* git.getReviewDiffPreview(input);
    return yield* new VcsUnsupportedOperationError({
      operation: "ReviewService.getDiffPreview",
      kind: handle.kind,
      detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    if (input.threadId !== undefined) {
      const workspace = yield* getWorkspace(input.threadId);
      if (workspace) {
        if (input.repositoryId !== undefined) {
          const repository = workspace.repositories.find(
            (entry) => entry.id === input.repositoryId,
          );
          if (!repository)
            return yield* new VcsRepositoryDetectionError({
              operation: "ReviewService.getDiffPreview",
              cwd: input.cwd,
              detail: "Select a repository declared in this thread's workspace.",
            });
          return yield* getSinglePreview(
            { ...input, cwd: repository.checkoutPath, summaryOnly: input.file === undefined },
            repository,
          );
        }
        if (input.file)
          return yield* new VcsRepositoryDetectionError({
            operation: "ReviewService.getDiffPreview",
            cwd: input.cwd,
            detail: "A workspace file patch requires a selected repository.",
          });
        const repositories = yield* Effect.forEach(
          workspace.repositories,
          (repository) =>
            getSinglePreview(
              {
                cwd: repository.checkoutPath,
                summaryOnly: true,
                ...(input.ignoreWhitespace === undefined
                  ? {}
                  : { ignoreWhitespace: input.ignoreWhitespace }),
              },
              repository,
            ).pipe(
              Effect.map((preview): ReviewRepositoryDiff => ({
                repository,
                sources: preview.sources,
              })),
              Effect.catch((cause) =>
                Effect.succeed({
                  repository,
                  sources: [],
                  error: cause.message,
                } satisfies ReviewRepositoryDiff),
              ),
            ),
          { concurrency: 4 },
        );
        return {
          cwd: workspace.workspaceRoot,
          generatedAt: yield* DateTime.now,
          sources: [],
          repositories,
        };
      }
    }
    if (input.repositoryId !== undefined)
      return yield* new VcsRepositoryDetectionError({
        operation: "ReviewService.getDiffPreview",
        cwd: input.cwd,
        detail: "Workspace repository selection requires its owning thread.",
      });
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);
    return yield* getSinglePreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    if (input.threadId !== undefined) {
      const workspace = yield* getWorkspace(input.threadId);
      if (workspace) {
        const repository = workspace.repositories.find((entry) => entry.id === input.repositoryId);
        if (!repository)
          return yield* new VcsRepositoryDetectionError({
            operation: "ReviewService.getDiffFileContents",
            cwd: input.cwd,
            detail: "Select a repository declared in this thread's workspace.",
          });
        yield* assertRepository(repository, input.cwd);
        return yield* git.getReviewDiffFileContents(input);
      }
    }
    if (input.repositoryId !== undefined)
      return yield* new VcsRepositoryDetectionError({
        operation: "ReviewService.getDiffFileContents",
        cwd: input.cwd,
        detail: "Workspace repository selection requires its owning thread.",
      });
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);
