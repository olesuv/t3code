import * as NodeCrypto from "node:crypto";

import { type CodeWorkspace, type WorkspaceRepository } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse, type ParseError } from "jsonc-parser";

import { expandHomePathWith } from "@t3tools/provider-core/server/pathExpansion";
import * as ProcessRunner from "../processRunner.ts";

const WorkspaceFile = Schema.Struct({
  folders: Schema.Array(
    Schema.Struct({
      path: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      uri: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decodeWorkspaceFile = Schema.decodeUnknownEffect(WorkspaceFile);

export class CodeWorkspaceLoadError extends Schema.TaggedError<CodeWorkspaceLoadError>()(
  "CodeWorkspaceLoadError",
  {
    filePath: Schema.String,
    reason: Schema.Literals([
      "read",
      "malformed",
      "uri",
      "folder-path",
      "folder-missing",
      "folder-not-directory",
      "git",
    ]),
    folderIndex: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const folder = this.folderIndex === undefined ? "" : ` at folders[${this.folderIndex}]`;
    switch (this.reason) {
      case "read":
        return `Cannot read workspace file ${this.filePath}. Check that it exists and is readable.`;
      case "malformed":
        return `Invalid workspace file ${this.filePath}. Expected JSON with a folders array; comments and trailing commas are allowed.`;
      case "uri":
        return `Unsupported URI entry${folder} in ${this.filePath}. Use a filesystem path on this environment.`;
      case "folder-path":
        return `Missing or invalid path${folder} in ${this.filePath}. Use a non-empty filesystem path.`;
      case "folder-missing":
        return `Cannot access folder${folder} in ${this.filePath}. Check that the directory exists on this environment.`;
      case "folder-not-directory":
        return `Workspace entry${folder} in ${this.filePath} is not a directory.`;
      case "git":
        return `Cannot inspect a Git repository for ${this.filePath}. Check Git and repository access on this environment.`;
    }
  }
}

export class CodeWorkspaceLoader extends Context.Service<
  CodeWorkspaceLoader,
  {
    readonly load: (filePath: string) => Effect.Effect<
      {
        readonly workspaceRoot: string;
        readonly workspace: CodeWorkspace;
      },
      CodeWorkspaceLoadError
    >;
  }
>()("t3/project/CodeWorkspaceLoader") {}

const stableId = (kind: string, canonicalPath: string) =>
  `${kind}-${NodeCrypto.createHash("sha256").update(canonicalPath).digest("hex")}`;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;

  const load: CodeWorkspaceLoader["Service"]["load"] = Effect.fn("CodeWorkspaceLoader.load")(
    function* (input) {
      const candidate = path.resolve(expandHomePathWith(input.trim(), path));
      const filePath = yield* fs
        .realPath(candidate)
        .pipe(
          Effect.mapError(
            (cause) => new CodeWorkspaceLoadError({ filePath: candidate, reason: "read", cause }),
          ),
        );
      const raw = yield* fs
        .readFileString(filePath)
        .pipe(
          Effect.mapError(
            (cause) => new CodeWorkspaceLoadError({ filePath, reason: "read", cause }),
          ),
        );
      const errors: ParseError[] = [];
      const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
      if (errors.length > 0)
        return yield* new CodeWorkspaceLoadError({ filePath, reason: "malformed" });
      const decoded = yield* decodeWorkspaceFile(parsed).pipe(
        Effect.mapError(
          (cause) => new CodeWorkspaceLoadError({ filePath, reason: "malformed", cause }),
        ),
      );
      const directory = path.dirname(filePath);
      const folders = yield* Effect.forEach(
        decoded.folders,
        Effect.fnUntraced(function* (folder, folderIndex) {
          if (folder.uri !== undefined)
            return yield* new CodeWorkspaceLoadError({ filePath, reason: "uri", folderIndex });
          const folderPath = folder.path?.trim();
          if (!folderPath || /^[a-z][a-z\d+.-]*:\/\//i.test(folderPath)) {
            return yield* new CodeWorkspaceLoadError({
              filePath,
              reason: "folder-path",
              folderIndex,
            });
          }
          const resolved = path.resolve(directory, folderPath);
          const canonical = yield* fs.realPath(resolved).pipe(
            Effect.mapError(
              (cause) =>
                new CodeWorkspaceLoadError({
                  filePath,
                  reason: "folder-missing",
                  folderIndex,
                  cause,
                }),
            ),
          );
          const stat = yield* fs.stat(canonical).pipe(
            Effect.mapError(
              (cause) =>
                new CodeWorkspaceLoadError({
                  filePath,
                  reason: "folder-missing",
                  folderIndex,
                  cause,
                }),
            ),
          );
          if (stat.type !== "Directory")
            return yield* new CodeWorkspaceLoadError({
              filePath,
              reason: "folder-not-directory",
              folderIndex,
            });
          return {
            id: stableId("folder", canonical),
            path: canonical,
            name: folder.name?.trim() || path.basename(canonical) || canonical,
          };
        }),
        { concurrency: 4 },
      );

      const gitRoot = Effect.fnUntraced(function* (cwd: string) {
        const result = yield* processes
          .run({
            command: "git",
            args: ["-C", cwd, "rev-parse", "--show-toplevel"],
            env: { LC_ALL: "C" },
            timeout: "10 seconds",
          })
          .pipe(
            Effect.mapError(
              (cause) => new CodeWorkspaceLoadError({ filePath, reason: "git", cause }),
            ),
          );
        if (result.code !== 0) {
          // Only absence of a repository is normal; permission/corruption errors must surface.
          if (result.stderr.includes("not a git repository")) return null;
          return yield* new CodeWorkspaceLoadError({ filePath, reason: "git" });
        }
        return yield* fs
          .realPath(result.stdout.trim())
          .pipe(
            Effect.mapError(
              (cause) => new CodeWorkspaceLoadError({ filePath, reason: "git", cause }),
            ),
          );
      });
      const metaRoot = yield* gitRoot(directory);
      const roots = yield* Effect.forEach(folders, (folder) => gitRoot(folder.path), {
        concurrency: 4,
      });
      const repositories = new Map<string, WorkspaceRepository>();
      if (metaRoot)
        repositories.set(metaRoot, {
          id: stableId("repository", metaRoot),
          name: path.basename(metaRoot) || metaRoot,
          checkoutPath: metaRoot,
        });
      for (const [index, root] of roots.entries()) {
        if (root && !repositories.has(root))
          repositories.set(root, {
            id: stableId("repository", root),
            name: folders[index]!.name,
            checkoutPath: root,
          });
      }
      return {
        workspaceRoot: metaRoot ?? directory,
        workspace: {
          filePath,
          workspaceRoot: metaRoot ?? directory,
          folders,
          repositories: [...repositories.values()],
        },
      };
    },
  );
  return CodeWorkspaceLoader.of({ load });
});

export const layer = Layer.effect(CodeWorkspaceLoader, make);
