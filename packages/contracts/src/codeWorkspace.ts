import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WorkspaceFolder = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type WorkspaceFolder = typeof WorkspaceFolder.Type;

export const WorkspaceRepository = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  checkoutPath: TrimmedNonEmptyString,
});
export type WorkspaceRepository = typeof WorkspaceRepository.Type;

/** Resolved on the owning environment; threads retain the descriptor they started with. */
export const CodeWorkspace = Schema.Struct({
  filePath: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  folders: Schema.Array(WorkspaceFolder),
  repositories: Schema.Array(WorkspaceRepository),
});
export type CodeWorkspace = typeof CodeWorkspace.Type;

/** Files include execution, declared folders, and repository checkout roots. */
export function workspaceFileRoots(workspace: CodeWorkspace): ReadonlyArray<WorkspaceFolder> {
  const repository = workspace.repositories.find(
    (entry) => entry.checkoutPath === workspace.workspaceRoot,
  );
  const roots = workspace.folders.some((folder) => folder.path === workspace.workspaceRoot)
    ? [...workspace.folders]
    : [
        {
          id: repository?.id ?? "workspace-root",
          name:
            repository?.name ??
            workspace.workspaceRoot
              .replace(/[\\/]+$/, "")
              .split(/[\\/]/)
              .at(-1) ??
            "Workspace",
          path: workspace.workspaceRoot,
        },
        ...workspace.folders,
      ];
  for (const repository of workspace.repositories) {
    if (!roots.some((root) => root.path === repository.checkoutPath)) {
      roots.push({ id: repository.id, name: repository.name, path: repository.checkoutPath });
    }
  }
  return roots;
}
