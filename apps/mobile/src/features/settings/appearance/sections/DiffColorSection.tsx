import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsChoiceRow } from "../../components/SettingsChoiceRow";

export function DiffColorSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences);
  const selected = ready ? (preferences.value.diffColorScheme ?? "red-green") : "red-green";
  return (
    <SettingsSection title="Diff count colors">
      <SettingsChoiceRow
        label="Red & green"
        description="Green additions and red deletions in repository change counts."
        selected={selected === "red-green"}
        separated={false}
        disabled={!ready}
        onPress={() => save({ diffColorScheme: "red-green" })}
      />
      <SettingsChoiceRow
        label="Blue & orange"
        description="Blue additions and orange deletions in repository change counts."
        selected={selected === "blue-orange"}
        separated
        disabled={!ready}
        onPress={() => save({ diffColorScheme: "blue-orange" })}
      />
    </SettingsSection>
  );
}
