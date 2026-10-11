import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value);
  const divisor = value < 1_000_000 ? 1000 : value < 1_000_000_000 ? 1_000_000 : 1_000_000_000;
  const suffix = divisor === 1000 ? "k" : divisor === 1_000_000 ? "m" : "b";
  const count = value / divisor;
  return `${count < 10 ? count.toFixed(1).replace(/\.0$/, "") : Math.round(count)}${suffix}`;
}

export function DiffStatLabel(props: { readonly additions: number; readonly deletions: number }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const blueOrange =
    AsyncResult.isSuccess(preferences) && preferences.value.diffColorScheme === "blue-orange";
  const { themeAppearance } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  return (
    <View
      accessible
      accessibilityLabel={`${props.additions} additions, ${props.deletions} deletions`}
      className="shrink-0 flex-row items-center gap-1"
    >
      <Text
        className={`font-mono text-xs ${blueOrange ? (dark ? "text-blue-400" : "text-blue-600") : "text-adaptive-emerald-600-400"}`}
      >
        +{formatCompactDiffCount(props.additions)}
      </Text>
      <Text
        className={`font-mono text-xs ${blueOrange ? (dark ? "text-orange-400" : "text-orange-600") : dark ? "text-red-400" : "text-red-600"}`}
      >
        -{formatCompactDiffCount(props.deletions)}
      </Text>
    </View>
  );
}
