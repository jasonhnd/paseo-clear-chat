import { useTranslation } from "@getpaseo/plugin/client";
import { messages } from "./messages";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { hostFontEscape } from "./components/host-font-escape";
import { SettingsFailureNotice } from "./components/settings-failure-notice";
import { openLink } from "./components/open-link";
import { radius, buildThemeTokens, type ExtendedThemeTokens } from "./components/theme-tokens";
import {
  retryEnhancerPreferences,
  updateEnhancerPreferences,
  useEnhancerPreferences,
  useEnhancerPreferencesError,
} from "./preferences";

// Paseo bundles SVG imports as text, so malformed JSON can be handled here.
let installedVersion: string | undefined;
try {
  const raw: unknown = require("./package-version.svg");
  const metadata: unknown = JSON.parse(typeof raw === "string" ? raw : "");
  const version = metadata && typeof metadata === "object" && "version" in metadata ? metadata.version : undefined;
  if (typeof version === "string" && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){3}$/.test(version)) installedVersion = version;
} catch {
  // Directory installs do not run the build hook and have no generated metadata.
}

const TRACK_WIDTH = 38;
const TRACK_HEIGHT = 22;
const KNOB = 16;

function SavedRepliesEditor({ value, tokens }: { value: string[]; tokens: ExtendedThemeTokens }) {
  const { t } = useTranslation(messages);
  const joined = value.join("\n");
  const [draft, setDraft] = useState(joined);
  useEffect(() => { setDraft(joined); }, [joined]);
  const save = () => updateEnhancerPreferences({ savedReplies: draft.split(/\r?\n/).map(item => item.trim()).filter(Boolean) });
  return <View style={[styles.row, { borderTopColor: tokens.borderSubtle }]}>
    <Text style={[styles.rowTitle, { color: tokens.foreground, fontFamily: tokens.fontUi }]}>{t("answerStyle.savedRepliesLabel")}</Text>
    <Text style={[styles.rowDescription, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}>{t("answerStyle.savedRepliesDescription")}</Text>
    <TextInput testID="saved-replies-input" accessibilityLabel={t("answerStyle.savedRepliesLabel")} accessibilityHint={t("answerStyle.savedRepliesDescription")} value={draft} onChangeText={setDraft} onBlur={() => { void save(); }} multiline autoCorrect={false} style={[styles.toolNamesInput, { color: tokens.foreground, borderColor: tokens.border, fontFamily: tokens.fontUi }]} />
  </View>;
}

/**
 * An on/off control that reads as one. A pair of buttons states the value
 * twice — the label and the selection — and a reader has to compare them to
 * learn which way it is set.
 */
function Toggle({
  value,
  onChange,
  label,
  tokens,
}: {
  value: boolean;
  onChange(next: boolean): void;
  label: string;
  tokens: ExtendedThemeTokens;
}) {
  const position = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    const animation = Animated.timing(position, {
      toValue: value ? 1 : 0,
      duration: 140,
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [value, position]);

  return (
    <Pressable
      accessibilityRole="switch"
      // React Native Web does not map `accessibilityState.checked` onto a
      // Pressable, so the ARIA attribute is set directly as well.
      aria-checked={value}
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange(!value)}
      style={[
        styles.track,
        {
          backgroundColor: value ? tokens.accent : tokens.surface2,
          borderColor: value ? tokens.accent : tokens.border,
        },
      ]}
    >
      <Animated.View
        style={[
          styles.knob,
          {
            backgroundColor: value ? tokens.accentForeground : tokens.foregroundMuted,
            transform: [
              {
                translateX: position.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, TRACK_WIDTH - KNOB - 6],
                }),
              },
            ],
          },
        ]}
      />
    </Pressable>
  );
}

/** A row whose control is a toggle: text on the left, switch on the right. */
function ToggleRow({
  title,
  description,
  value,
  onChange,
  tokens,
}: {
  title: string;
  description: string;
  value: boolean;
  onChange(next: boolean): void;
  tokens: ExtendedThemeTokens;
}) {
  return (
    <View style={[styles.row, styles.toggleRow, styles.firstRow, { borderTopColor: tokens.borderSubtle }]}>
      <View style={styles.toggleText}>
        <Text style={[styles.rowTitle, { color: tokens.foreground, fontFamily: tokens.fontUi }]}>
          {title}
        </Text>
        <Text
          style={[
            styles.rowDescription,
            { color: tokens.foregroundMuted, fontFamily: tokens.fontUi },
          ]}
        >
          {description}
        </Text>
      </View>
      <Toggle value={value} onChange={onChange} label={title} tokens={tokens} />
    </View>
  );
}

/** Settings content mounted by Paseo under the selected host's Plugin settings. */
export function ClearChatSettingsPage({ theme }: PluginSurfaceProps) {
  const { t } = useTranslation(messages);
  const preferences = useEnhancerPreferences();
  const storageError = useEnhancerPreferencesError();
  const tokens = useMemo(
    () => buildThemeTokens(theme.colors, preferences),
    [preferences, theme.colors],
  );
  const [versionPrefix, versionSuffix] = t("settings.version", { version: "__VERSION__" }).split("__VERSION__");

  return (
    <View {...hostFontEscape} style={[styles.container, { backgroundColor: tokens.surface0 }]}>
      <View
        style={[
          styles.intro,
          { borderColor: tokens.borderSubtle, backgroundColor: tokens.surface1 },
        ]}
      >
        <Text style={[styles.title, { color: tokens.foreground, fontFamily: tokens.fontUi }]}>
          {t("settings.title")}
        </Text>
        <Text
          style={[styles.description, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}
        >
          {t("settings.intro")}
        </Text>
        <Text testID="installed-version" style={[styles.version, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}>
          {versionPrefix}<Text style={[styles.versionValue, { color: tokens.foreground, fontFamily: tokens.fontMono }]}>{installedVersion ?? t("hub.unknown").replace(/^./, letter => letter.toUpperCase())}</Text>{versionSuffix}
        </Text>
        <Text testID="installed-version-note" style={[styles.description, styles.versionNote, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}>
          {t("settings.versionNote")}
        </Text>
      </View>

      {storageError ? (
        <SettingsFailureNotice message={storageError} onRetry={retryEnhancerPreferences} tokens={tokens} />
      ) : null}

      <View
        style={[
          styles.card,
          { borderColor: tokens.borderSubtle, backgroundColor: tokens.surfaceGlass },
        ]}
      >
        <ToggleRow
          title={t("settings.answerCard.label")}
          description={t("settings.answerCard.description")}
          value={preferences.showAnswerCard}
          onChange={(showAnswerCard) => updateEnhancerPreferences({ showAnswerCard })}
          tokens={tokens}
        />
        <SavedRepliesEditor value={preferences.savedReplies} tokens={tokens} />
      </View>

      <Pressable
        accessibilityRole="link"
        onPress={() => openLink("https://github.com/jasonhnd/paseo-clear-chat/issues/new?template=bug_report.yml")}
        style={[
          styles.card,
          styles.row,
          styles.firstRow,
          { borderColor: tokens.borderSubtle, backgroundColor: tokens.surfaceGlass },
        ]}
      >
        <Text style={[styles.rowTitle, { color: tokens.foreground, fontFamily: tokens.fontUi }]}>
          {t("settings.report")}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: "stretch", padding: 16, gap: 12 },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  toggleText: { flex: 1, minWidth: 0, gap: 8 },
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    borderWidth: 1,
    padding: 2,
    justifyContent: "center",
  },
  knob: { width: KNOB, height: KNOB, borderRadius: KNOB / 2 },
  intro: { padding: 14, borderWidth: 1, borderRadius: radius.card, gap: 4 },
  title: { fontSize: 16, fontWeight: "700" },
  description: { fontSize: 13, lineHeight: 18 },
  version: { fontSize: 11, lineHeight: 18, marginTop: 8 },
  versionValue: { fontSize: 13, fontWeight: "600" },
  versionNote: { maxWidth: 380, marginTop: 4 },
  card: { borderWidth: 1, borderRadius: radius.card, overflow: "hidden" },
  row: { padding: 14, gap: 8, borderTopWidth: 1 },
  firstRow: { borderTopWidth: 0 },
  rowTitle: { fontSize: 14, fontWeight: "600" },
  rowDescription: { fontSize: 12, lineHeight: 17 },
  toolNamesInput: { alignSelf: "stretch", minWidth: 0, minHeight: 44, borderWidth: 1, borderRadius: radius.block, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16 },
});
