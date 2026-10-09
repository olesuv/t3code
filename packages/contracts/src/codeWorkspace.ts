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

/** Files include the execution root as well as every declared named folder. */
export function workspaceFileRoots(workspace: CodeWorkspace): ReadonlyArray<WorkspaceFolder> {
  if (workspace.folders.some((folder) => folder.path === workspace.workspaceRoot))
    return workspace.folders;
  const repository = workspace.repositories.find(
    (entry) => entry.checkoutPath === workspace.workspaceRoot,
  );
  return [
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
}
