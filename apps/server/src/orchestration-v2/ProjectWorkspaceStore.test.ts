import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, type CodeWorkspace } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ApplicationProjectEvent } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

const workspace = (filePath: string): CodeWorkspace => ({
  filePath,
  workspaceRoot: "/workspace/meta",
  folders: [{ id: "folder-one", name: "One", path: "/workspace/meta/one" }],
  repositories: [{ id: "repo-one", name: "One", checkoutPath: "/workspace/meta/one" }],
});

const decodeEvent = Schema.decodeUnknownSync(ApplicationProjectEvent);
const created = (projectId: ProjectId, descriptor?: CodeWorkspace) =>
  decodeEvent({
    sequence: 1,
    eventId: EventId.make(`event:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`command:${projectId}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Workspace",
      workspaceRoot: "/workspace/meta",
      ...(descriptor === undefined ? {} : { workspace: descriptor }),
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });

const layer = ProjectStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-store-" })),
  Layer.provide(NodeServices.layer),
);

it.layer(layer)("ProjectStore workspace descriptors", (it) => {
  it.effect(
    "persists workspace membership and identifies each file independently of execution directory",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectStore.ProjectStoreV2;
        const a = ProjectId.make("workspace-a");
        const b = ProjectId.make("workspace-b");
        const ordinary = ProjectId.make("ordinary");
        const descriptorA = workspace("/workspace/meta/a.code-workspace");
        const descriptorB = workspace("/workspace/meta/b.code-workspace");
        yield* store.apply(created(a, descriptorA));
        yield* store.apply(created(b, descriptorB));
        // A historical directory event has no descriptor and still decodes.
        yield* store.apply(created(ordinary));
        expect(Option.getOrThrow(yield* store.get(a)).workspace).toEqual(descriptorA);
        expect(Option.getOrThrow(yield* store.getShell(a)).workspace).toEqual(descriptorA);
        expect(
          Option.getOrThrow(yield* store.findActiveByWorkspaceRoot("/workspace/meta")).projectId,
        ).toBe(ordinary);
        expect(
          Option.getOrThrow(
            yield* store.findActiveByWorkspaceRoot("/workspace/meta", descriptorA.filePath),
          ).projectId,
        ).toBe(a);
        expect(
          Option.getOrThrow(
            yield* store.findActiveByWorkspaceRoot("/workspace/meta", descriptorB.filePath),
          ).projectId,
        ).toBe(b);
        expect(Option.getOrThrow(yield* store.get(ordinary)).workspace).toBeNull();

        const original = created(a, descriptorA);
        const replacement = { ...descriptorA, folders: [], repositories: [] };
        yield* store.apply({
          ...original,
          type: "project.meta-updated",
          payload: { projectId: a, workspace: replacement, updatedAt: "2026-01-02T00:00:00.000Z" },
        });
        expect(Option.getOrThrow(yield* store.get(a)).workspace).toEqual(replacement);
        yield* store.apply({
          ...original,
          type: "project.meta-updated",
          payload: { projectId: a, title: "Renamed", updatedAt: "2026-01-03T00:00:00.000Z" },
        });
        expect(Option.getOrThrow(yield* store.get(a)).workspace).toEqual(replacement);
        yield* store.apply({
          ...original,
          type: "project.meta-updated",
          payload: { projectId: a, workspace: null, updatedAt: "2026-01-04T00:00:00.000Z" },
        });
        expect(Option.getOrThrow(yield* store.get(a)).workspace).toBeNull();
        expect(
          Option.isNone(
            yield* store.findActiveByWorkspaceRoot("/workspace/meta", descriptorA.filePath),
          ),
        ).toBe(true);
      }),
  );
});
