import { useCallback, useState, type ReactNode } from "react";
import { useNavigation } from "@react-navigation/native";
import { Pressable, ScrollView, View } from "react-native";
import type { CodeWorkspace, WorkspaceRepository } from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { ScreenHeader } from "../../components/ScreenHeader";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { useCheckpointDiff } from "../../state/queries";
import { useThreadProjection } from "../../state/use-thread-detail";
import { useFilesystemReadAccess } from "../../state/filesystem";
import { DiffStatLabel } from "./DiffStatLabel";
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
  const navigation = useNavigation();
  const handleReturnToThread = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.navigate("Thread", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  }, [environmentId, navigation, threadId]);
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
    <>
      <ScreenHeader
        title="All repositories"
        options={{ headerTitle: "All repositories" }}
        onBack={handleReturnToThread}
        backInSplitView={{ accessibilityLabel: "Back to chat", icon: "chevron.left" }}
      />
      <MaterialScreenContent>
        <ScrollView
          className="flex-1 bg-sheet android:bg-sheet-solid"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16 }}
        >
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
            groups?.map((group) => {
              const totals = group.files.reduce(
                (total, file) => ({
                  additions: total.additions + file.additions,
                  deletions: total.deletions + file.deletions,
                }),
                { additions: 0, deletions: 0 },
              );
              return (
                <Pressable
                  key={group.repository.id}
                  accessibilityRole="button"
                  onPress={() => setRepositoryId(group.repository.id)}
                  className="mb-4 gap-1 rounded-lg px-3 py-2 active:bg-row-hover"
                >
                  <View className="flex-row items-center gap-2">
                    <Text numberOfLines={1} className="min-w-0 flex-1 text-sm font-medium">
                      {group.repository.name}
                    </Text>
                    {!group.error && group.files.length > 0 ? (
                      <DiffStatLabel additions={totals.additions} deletions={totals.deletions} />
                    ) : null}
                  </View>
                  <Text numberOfLines={1} className="text-xs text-muted-foreground">
                    {group.repository.checkoutPath}
                  </Text>
                  {group.error ? (
                    <Text accessibilityRole="alert" className="text-sm">
                      {group.error}
                    </Text>
                  ) : group.incomplete ? (
                    <Text className="text-sm text-muted-foreground">
                      Summary incomplete. Open this repository to load changes.
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
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
    </>
  );
}
