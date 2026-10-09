// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import { workspaceFileRoots } from "@t3tools/contracts";
import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import { expandHomePathWith } from "@t3tools/provider-core/server/pathExpansion";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export class WorkspaceEntriesWorkspaceError extends Schema.TaggedError<WorkspaceEntriesWorkspaceError>()(
  "WorkspaceEntriesWorkspaceError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceEntriesWorkspaceError,
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePathWith(input.partialPath, path));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(expandHomePathWith(input.cwd, path), input.partialPath);
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const resolveRoots = Effect.fn("WorkspaceEntries.resolveRoots")(function* (
    input: Pick<ProjectSearchEntriesInput, "threadId" | "projectId" | "rootId">,
  ) {
    const error = (message: string) => new WorkspaceEntriesWorkspaceError({ message });
    const workspace = input.threadId
      ? yield* projections.getThreadShell(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceEntriesWorkspaceError({
                message: "Could not read the thread's workspace folders.",
                cause,
              }),
          ),
          Effect.flatMap((thread) =>
            thread
              ? Effect.succeed(thread.workspace)
              : Effect.fail(
                  error("This thread no longer exists. Reload before browsing its folders."),
                ),
          ),
        )
      : input.projectId
        ? yield* projects.get(input.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceEntriesWorkspaceError({
                  message: "Could not read the project's workspace folders.",
                  cause,
                }),
            ),
            Effect.flatMap((project) =>
              Option.isSome(project)
                ? Effect.succeed(project.value.workspace)
                : Effect.fail(
                    error("This project no longer exists. Reload before browsing its folders."),
                  ),
            ),
          )
        : null;
    if (!workspace) {
      if (input.rootId)
        return yield* error("A workspace root requires a workspace project or thread.");
      return null;
    }
    const roots = workspaceFileRoots(workspace);
    if (!input.rootId) return roots;
    const root = roots.find((entry) => entry.id === input.rootId);
    return root
      ? [root]
      : yield* error("The selected folder is not part of this workspace thread or project.");
  });

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = (
          cause:
            | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
            | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
            | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
        ) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          });
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{
        readonly name: string;
        readonly fullPath: string;
        readonly kind?: "workspace";
      }> = [];
      for (const dirent of dirents) {
        if (
          (dirent.isDirectory() ||
            (input.includeWorkspaceFiles &&
              dirent.isFile() &&
              dirent.name.endsWith(".code-workspace"))) &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
            ...(dirent.isFile() ? { kind: "workspace" as const } : {}),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const roots = yield* resolveRoots(input);
      if (roots) {
        const matchingRoots = roots.filter((root) => input.query.startsWith(`${root.name}/`));
        const selected = matchingRoots.length ? matchingRoots : roots;
        const perRootLimit = Math.max(1, Math.floor(input.limit / Math.max(1, selected.length)));
        const results = yield* Effect.forEach(
          selected.slice(0, input.limit),
          (root) =>
            search({
              cwd: root.path,
              query: matchingRoots.length ? input.query.slice(root.name.length + 1) : input.query,
              limit: perRootLimit,
              ...(input.kind ? { kind: input.kind } : {}),
              ...(input.imageOnly ? { imageOnly: true } : {}),
            }).pipe(
              Effect.map((result) => ({ root, result, error: null })),
              Effect.catch((cause) => Effect.succeed({ root, result: null, error: cause.message })),
            ),
          { concurrency: 4 },
        );
        return {
          entries: results
            .flatMap(
              (entry) => entry.result?.entries.map((file) => ({ ...file, root: entry.root })) ?? [],
            )
            .slice(0, input.limit),
          truncated:
            selected.length > input.limit || results.some((entry) => entry.result?.truncated),
          rootErrors: results.flatMap((entry) =>
            entry.error ? [{ root: entry.root, message: entry.error }] : [],
          ),
        };
      }
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const roots = yield* resolveRoots(input);
    if (roots) {
      const perRootLimit = Math.max(1, Math.floor(input.limit / Math.max(1, roots.length)));
      const results = yield* Effect.forEach(
        roots.slice(0, input.limit),
        (root) =>
          searchContents({
            cwd: root.path,
            query: input.query,
            limit: perRootLimit,
            caseSensitive: input.caseSensitive,
            wholeWord: input.wholeWord,
            useRegex: input.useRegex,
          }).pipe(
            Effect.map((result) => ({ root, result, error: null })),
            Effect.catch((cause) => Effect.succeed({ root, result: null, error: cause.message })),
          ),
        { concurrency: 4 },
      );
      return {
        matches: results
          .flatMap(
            (entry) => entry.result?.matches.map((match) => ({ ...match, root: entry.root })) ?? [],
          )
          .slice(0, input.limit),
        truncated: roots.length > input.limit || results.some((entry) => entry.result?.truncated),
        rootErrors: results.flatMap((entry) =>
          entry.error ? [{ root: entry.root, message: entry.error }] : [],
        ),
        ...(results.find((entry) => entry.result?.regexFallbackError)?.result?.regexFallbackError
          ? {
              regexFallbackError: results.find((entry) => entry.result?.regexFallbackError)!.result!
                .regexFallbackError,
            }
          : {}),
      };
    }
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const roots = yield* resolveRoots(input);
      if (roots) {
        if (!input.rootId) return { entries: [], truncated: false, roots };
        const root = roots[0]!;
        const result = yield* list({
          cwd: root.path,
          ...(input.directoryPath !== undefined ? { directoryPath: input.directoryPath } : {}),
        });
        return { ...result, entries: result.entries.map((entry) => ({ ...entry, root })) };
      }
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        const entries = yield* Effect.tryPromise({
          try: async () => {
            const root = await NodeFSP.realpath(normalizedCwd);
            const directory = await NodeFSP.realpath(target.absolutePath);
            const relative = path.relative(root, directory);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes(".git") ||
              target.relativePath.split("/").includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
            const children = await NodeFSP.readdir(directory, { withFileTypes: true });
            return children.flatMap((child): ProjectEntry[] => {
              if (child.name === ".git" || (!child.isDirectory() && !child.isFile())) return [];
              return [
                {
                  path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                  kind: child.isDirectory() ? "directory" : "file",
                },
              ];
            });
          },
          catch: toError,
        });
        // Use stdin so large directories cannot exceed the command-line argument limit.
        // Ignore classification is optional in non-git workspaces or when git is unavailable.
        const ignored = new Set<string>();
        for (let offset = 0; offset < entries.length; offset += 1000) {
          const chunk = entries.slice(offset, offset + 1000);
          const result = yield* vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: normalizedCwd,
              stdin: `${chunk.map((entry) => entry.path).join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0")) ignored.add(ignoredPath);
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
        };
      }
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  return WorkspaceEntries.of({ browse, list, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
);
