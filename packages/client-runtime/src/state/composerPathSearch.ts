import type { EnvironmentId, ProjectId, ThreadId, WorkspaceFolder } from "@t3tools/contracts";

export interface ComposerPathSearchEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly parentPath?: string;
  readonly root?: WorkspaceFolder;
}

export interface ComposerPathSearchState {
  readonly entries: ReadonlyArray<ComposerPathSearchEntry>;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string | null;
  readonly threadId?: ThreadId | undefined;
  readonly projectId?: ProjectId | undefined;
}
