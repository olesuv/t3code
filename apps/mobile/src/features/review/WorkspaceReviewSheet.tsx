import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { CodeWorkspace, WorkspaceRepository } from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { useCheckpointDiff } from "../../state/queries";
import { useThreadProjection } from "../../state/use-thread-detail";
import { useFilesystemReadAccess } from "../../state/filesystem";
import type { ReviewSheetProps } from "./ReviewSheet";

/** Summaries keep each checkout's namespace separate until a repository is opened. */
export function WorkspaceReviewSheet(
  props: ReviewSheetProps & {
    readonly workspace: CodeWorkspace;
    readonly renderRepository: (
      repository: WorkspaceRepository,
      fullThread: boolean,
      initialSection: string,
      showAll: () => void,
    ) => ReactNode;
  },
) {
  const { environmentId, threadId } = props.route.params;
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [scope, setScope] = useState("branch");
  const repository = props.workspace.repositories.find((entry) => entry.id === repositoryId);
  const thread = useThreadProjection({ environmentId, threadId });
  const turns = (thread?.projection.checkpoints ?? [])
    .filter((entry) => entry.appRunOrdinal !== null && entry.runId !== null)
    .sort((a, b) => b.appRunOrdinal! - a.appRunOrdinal!);
  const checkpoint =
    scope === "thread" ? turns[0] : turns.find((entry) => `turn:${entry.appRunOrdinal}` === scope);
  const access = useFilesystemReadAccess(environmentId);
  const preview = useEnvironmentQuery(
    !repository && !checkpoint && access.canReadFiles
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: props.workspace.workspaceRoot, threadId },
        })
      : null,
  );
  const history = useCheckpointDiff({
    environmentId,
    threadId,
    fromTurnCount:
      !repository && checkpoint && access.canReadFiles
        ? scope === "thread"
          ? 0
          : Math.max(0, checkpoint.appRunOrdinal! - 1)
        : null,
    toTurnCount: checkpoint?.appRunOrdinal ?? null,
    ignoreWhitespace: false,
  });
  const groups = checkpoint
    ? history.data?.repositories?.map((entry) => ({
        repository: entry.repository,
        error: entry.error,
        files: entry.files,
        incomplete: false,
      }))
    : preview.data?.repositories?.map((entry) => {
        const source = entry.sources.find(
          (source) => source.kind === (scope === "unstaged" ? "working-tree" : "branch-range"),
        );
        return {
          repository: entry.repository,
          error: entry.error,
          files: source?.files ?? [],
          incomplete: source?.truncated ?? false,
        };
      });
  if (repository)
    return props.renderRepository(
      repository,
      scope === "thread",
      checkpoint
        ? `turn:${checkpoint.appRunOrdinal}`
        : `git:${scope === "unstaged" ? "working-tree" : "branch-range"}`,
      () => setRepositoryId(null),
    );
  const error = checkpoint ? history.error : preview.error;
  const pending = checkpoint ? history.isPending : preview.isPending;
  return (
    <MaterialScreenContent>
      <ScrollView
        className="flex-1 bg-sheet android:bg-sheet-solid"
        contentContainerStyle={{ padding: 16 }}
      >
        <Text className="mb-3 text-lg font-semibold">All repositories</Text>
        <ScrollView horizontal className="mb-3" showsHorizontalScrollIndicator={false}>
          {[
            { id: "branch", title: "Changes" },
            { id: "unstaged", title: "Uncommitted" },
            ...(turns.length ? [{ id: "thread", title: "Full thread" }] : []),
            ...turns.map((entry) => ({
              id: `turn:${entry.appRunOrdinal}`,
              title: `Turn ${entry.appRunOrdinal}`,
            })),
          ].map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityState={{ selected: scope === entry.id }}
              onPress={() => setScope(entry.id)}
              className="mr-3 py-2"
            >
              <Text className={scope === entry.id ? "font-semibold" : "text-muted-foreground"}>
                {entry.title}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {access.isPending || pending ? (
          <Text>Loading repository changes…</Text>
        ) : !access.canReadFiles ? (
          <Text>File access is required to review workspace changes.</Text>
        ) : error ? (
          <Text accessibilityRole="alert">{error}</Text>
        ) : null}
        {access.canReadFiles &&
          groups?.map((group) => (
            <View key={group.repository.id} className="mb-4">
              <Pressable
                accessibilityRole="button"
                onPress={() => setRepositoryId(group.repository.id)}
                className="py-2"
              >
                <Text className="font-semibold">{group.repository.name}</Text>
                <Text className="text-xs text-muted-foreground">
                  {group.repository.checkoutPath}
                </Text>
              </Pressable>
              {group.error ? (
                <Text accessibilityRole="alert">{group.error}</Text>
              ) : group.incomplete ? (
                <Text>Summary incomplete. Open this repository to load changes.</Text>
              ) : !group.files.length ? (
                <Text className="text-muted-foreground">No changes</Text>
              ) : (
                group.files.map((file) => (
                  <Pressable
                    key={JSON.stringify([environmentId, group.repository.id, file.path])}
                    accessibilityRole="button"
                    onPress={() => setRepositoryId(group.repository.id)}
                    className="py-2"
                  >
                    <Text>
                      {file.path} · +{file.additions} −{file.deletions}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
          ))}
        {!props.workspace.repositories.length ? (
          <Text>This workspace has no Git repositories.</Text>
        ) : null}
        {access.canReadFiles ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => (checkpoint ? history.refresh() : preview.refresh())}
            className="py-2"
          >
            <Text>Refresh</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </MaterialScreenContent>
  );
}
