import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type CodeWorkspace,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";
import * as NodePath from "node:path";

/**
 * ERRORS
 */
export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export class WorkspaceProviderRootsUnsupportedError extends Schema.TaggedError<WorkspaceProviderRootsUnsupportedError>()(
  "WorkspaceProviderRootsUnsupportedError",
  { providerInstanceId: ProviderInstanceId, externalRootCount: Schema.Number },
) {
  override get message(): string {
    return `Provider ${this.providerInstanceId} does not support external workspace folders. Choose Codex, Claude, OpenCode, or Antigravity, or use folders inside the workspace directory.`;
  }
}

export const validateWorkspaceProviderRoots = (input: {
  readonly workspace: CodeWorkspace;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: OrchestrationV2ProviderCapabilities | undefined;
}) => {
  const externalRootCount = [
    ...new Set(input.workspace.folders.map((folder) => folder.path)),
  ].filter((directory) => {
    const relative = NodePath.relative(input.workspace.workspaceRoot, directory);
    return (
      relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)
    );
  }).length;
  return externalRootCount > 0 &&
    input.capabilities?.runtimePolicy.supportsAdditionalWorkspaceRoots !== true
    ? Effect.fail(
        new WorkspaceProviderRootsUnsupportedError({
          providerInstanceId: input.providerInstanceId,
          externalRootCount,
        }),
      )
    : Effect.void;
};

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  WorkspaceProviderRootsUnsupportedError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  additionalDirectories: Schema.optional(Schema.Array(Schema.String)),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.workspace?.workspaceRoot ?? input.thread.worktreePath,
      ...(input.thread.workspace
        ? {
            additionalDirectories: [
              ...new Set(input.thread.workspace.folders.map((folder) => folder.path)),
            ],
          }
        : {}),
    }),
});

/**
 * The mode a provider runs a thread in. A mode the provider does not offer
 * (a thread set before it stopped offering it, or a stale client) runs in
 * Supervised rather than having T3 imitate it.
 */
function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const cwd =
          input.thread.worktreePath ??
          input.thread.workspace?.workspaceRoot ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        const additionalDirectories = [
          ...new Set(input.thread.workspace?.folders.map((folder) => folder.path) ?? []),
        ];
        if (input.thread.workspace) {
          const capabilities =
            instance === undefined
              ? undefined
              : yield* instance.orchestrationAdapter.getCapabilities().pipe(
                  Effect.mapError(
                    (cause) =>
                      new RuntimePolicyResolveError({
                        projectId: input.thread.projectId,
                        providerInstanceId: input.modelSelection.instanceId,
                        cause,
                      }),
                  ),
                );
          yield* validateWorkspaceProviderRoots({
            workspace: input.thread.workspace,
            capabilities,
            providerInstanceId: input.modelSelection.instanceId,
          });
        }
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          ...(input.thread.workspace ? { additionalDirectories } : {}),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.additionalDirectories === undefined
                  ? {}
                  : { additionalDirectories: override.additionalDirectories }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
