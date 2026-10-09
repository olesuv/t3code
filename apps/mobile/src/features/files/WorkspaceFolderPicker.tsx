import { Pressable, ScrollView } from "react-native";
import type { WorkspaceFolder } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";

export function WorkspaceFolderPicker(props: {
  readonly roots: ReadonlyArray<WorkspaceFolder>;
  readonly selectedId: string | undefined;
  readonly onSelect: (rootId: string) => void;
}) {
  if (!props.roots.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-12 px-3">
      {props.roots.map((root) => (
        <Pressable
          key={root.id}
          accessibilityRole="button"
          accessibilityLabel={`Browse ${root.name}`}
          accessibilityState={{ selected: root.id === props.selectedId }}
          onPress={() => props.onSelect(root.id)}
          className="mr-3 py-3"
        >
          <Text
            className={root.id === props.selectedId ? "font-semibold" : "text-muted-foreground"}
          >
            {root.name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
