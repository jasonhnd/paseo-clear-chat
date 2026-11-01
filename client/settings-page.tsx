import { useSettings, useTranslation } from "@getpaseo/plugin/client";
import { messages } from "./messages";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { customAccentSchema, hermesCcSettings } from "../shared/settings";
import { hostFontEscape } from "./components/host-font-escape";
import { SettingsFailureNotice } from "./components/settings-failure-notice";
import { openLink } from "./components/open-link";
import { radius, buildThemeTokens, type ExtendedThemeTokens } from "./components/theme-tokens";
import { CODE_FONT_OPTIONS } from "./components/code-fonts";
import {
  ACCENT_PRESETS,
  TEXT_SIZE_OPTIONS,
  OUTPUT_LINE_OPTIONS,
  resetEnhancerPreferences,
  retryEnhancerPreferences,
  updateEnhancerPreferences,
  useEnhancerPreferences,
  useEnhancerPreferencesError,
  type AccentPreset,
  type CodeFontPreference,
  type UiFontPreference,
  type OutputLineLimit,
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

const ACCENT_OPTIONS: ReadonlyArray<{
  id: AccentPreset;
  label: string;
  color: string | undefined;
}> = [
  { id: "host", label: "Host theme", color: undefined },
  { id: "jade", label: "Jade", color: ACCENT_PRESETS.jade },
  { id: "violet", label: "Violet", color: ACCENT_PRESETS.violet },
  { id: "amber", label: "Amber", color: ACCENT_PRESETS.amber },
  { id: "rose", label: "Rose", color: ACCENT_PRESETS.rose },
];

const CODE_FONT_LABELS = {
  "host": "settings.codeFont.default",
  "iosevka": "settings.codeFont.iosevka",
  "menlo": "settings.codeFont.menlo",
  "consolas": "settings.codeFont.consolas",
  "fira-code": "settings.codeFont.fira",
  "cascadia-code": "settings.codeFont.cascadia",
} as const;

const TEXT_SIZE_LABELS = {
  "0.9": "settings.textSize.small",
  "1": "settings.textSize.default",
  "1.15": "settings.textSize.large",
  "1.3": "settings.textSize.xl",
} as const;

const OUTPUT_LINE_LABELS = {
  "10": "settings.foldOutput.lines10",
  "15": "settings.foldOutput.lines15",
  "30": "settings.foldOutput.lines30",
  "never": "settings.foldOutput.never",
} as const;

const TRACK_WIDTH = 38;
const TRACK_HEIGHT = 22;
const KNOB = 16;

const CUSTOM_SWATCHES = ["#e63946", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

function CustomAccentPicker({ value, tokens }: { value: string; tokens: ExtendedThemeTokens }) {
  const { t } = useTranslation(messages);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState(false);
  useEffect(() => { setDraft(value); setError(false); }, [value]);
  const choose = (hex: string) => {
    setDraft(hex);
    setError(false);
    return updateEnhancerPreferences({ customAccent: hex, customAccentEnabled: true });
  };
  const apply = () => {
    const result = customAccentSchema.safeParse(draft);
    if (!result.success) {
      setError(true);
      return;
    }
    return choose(result.data);
  };
  return (
    <View testID="custom-accent-picker" style={styles.customPicker}>
      <View style={styles.accentOptions}>
        {CUSTOM_SWATCHES.map((hex) => (
          <Pressable
            key={hex}
            accessibilityRole="button"
            accessibilityLabel={t("settings.accent.useSwatchA11y", { hex })}
            accessibilityState={{ selected: value === hex }}
            onPress={() => choose(hex)}
            style={[styles.colourChoice, { borderColor: value === hex ? tokens.accent : tokens.border }]}
          >
            <View style={[styles.colourSample, { backgroundColor: hex }]} />
          </Pressable>
        ))}
      </View>
      <View style={styles.hexControls}>
        <TextInput
          accessibilityLabel={t("settings.accent.hexLabel")}
          accessibilityHint={t("settings.accent.hexHint")}
          value={draft}
          onChangeText={(text) => { setDraft(text); setError(false); }}
          onSubmitEditing={apply}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder={t("settings.accent.hexPlaceholder")}
          placeholderTextColor={tokens.foregroundMuted}
          returnKeyType="done"
          style={[styles.hexInput, { color: tokens.foreground, borderColor: error ? tokens.danger : tokens.border, fontFamily: tokens.fontMono }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.accent.applyA11y")}
          onPress={apply}
          style={[styles.applyColour, { backgroundColor: tokens.accent }]}
        >
          <Text style={[styles.accentLabel, { color: tokens.accentForeground, fontFamily: tokens.fontUi }]}>{t("settings.accent.apply")}</Text>
        </Pressable>
      </View>
      {error ? <Text accessibilityRole="alert" style={[styles.rowDescription, { color: tokens.foreground, fontFamily: tokens.fontUi }]}>{t("settings.accent.invalid")}</Text> : null}
      <Text style={[styles.rowDescription, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}>
        {t("settings.accent.contrastHelp")}
      </Text>
    </View>
  );
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
    <View style={[styles.row, styles.toggleRow, { borderTopColor: tokens.borderSubtle }]}>
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

function OptionButton({
  label,
  selected,
  onPress,
  tokens,
}: {
  label: string;
  selected: boolean;
  onPress(): void;
  tokens: ExtendedThemeTokens;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.option,
        {
          backgroundColor: selected ? tokens.accentBg : tokens.surface2,
          borderColor: selected ? tokens.accent : tokens.borderSubtle,
        },
      ]}
    >
      <Text
        style={[
          styles.optionLabel,
          { color: selected ? tokens.accent : tokens.foregroundMuted, fontFamily: tokens.fontUi },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ChoiceRow<T extends string>({
  title,
  description,
  value,
  options,
  onChange,
  tokens,
}: {
  title: string;
  description: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
  tokens: ExtendedThemeTokens;
}) {
  return (
    <View style={[styles.row, { borderTopColor: tokens.borderSubtle }]}>
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
      <View style={styles.options}>
        {options.map((option) => (
          <OptionButton
            key={option.value}
            label={option.label}
            selected={value === option.value}
            onPress={() => onChange(option.value)}
            tokens={tokens}
          />
        ))}
      </View>
    </View>
  );
}

/** Settings content mounted by Paseo under the selected host's Plugin settings. */
export function ClearChatSettingsPage({ theme }: PluginSurfaceProps) {
  const { t } = useTranslation(messages);
  const hermesCc = useSettings(hermesCcSettings);
  const preferences = useEnhancerPreferences();
  const storageError = useEnhancerPreferencesError();
  const tokens = useMemo(
    () => buildThemeTokens(theme.colors, preferences),
    [preferences, theme.colors],
  );

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
        <Text testID="installed-version" style={[styles.description, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}>
          {t("settings.version", { version: installedVersion ?? t("hub.unknown").replace(/^./, letter => letter.toUpperCase()) })}
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
        <View style={styles.row}>
          <Text style={[styles.rowTitle, { color: tokens.foreground, fontFamily: tokens.fontUi }]}>
            {t("settings.accent.label")}
          </Text>
          <Text
            style={[
              styles.rowDescription,
              { color: tokens.foregroundMuted, fontFamily: tokens.fontUi },
            ]}
          >
            {t("settings.accent.description")}
          </Text>
          <View style={styles.accentOptions}>
            {ACCENT_OPTIONS.map((option) => {
              const selected = !preferences.customAccentEnabled && preferences.accent === option.id;
              const swatch = option.color ?? theme.colors.accent;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityLabel={t("settings.accent.optionA11y", { label: t(`settings.accent.${option.id}`) })}
                  accessibilityState={{ selected }}
                  onPress={() => updateEnhancerPreferences({ accent: option.id, customAccentEnabled: false })}
                  style={[
                    styles.accentOption,
                    {
                      borderColor: selected ? tokens.accent : tokens.borderSubtle,
                      backgroundColor: selected ? tokens.accentBg : tokens.surface2,
                    },
                  ]}
                >
                  <View style={[styles.swatch, { backgroundColor: swatch }]} />
                  <Text
                    style={[
                      styles.accentLabel,
                      {
                        color: selected ? tokens.accent : tokens.foregroundMuted,
                        fontFamily: tokens.fontUi,
                      },
                    ]}
                  >
                    {t(`settings.accent.${option.id}`)}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.accent.customA11y")}
              accessibilityState={{ selected: !!preferences.customAccentEnabled }}
              onPress={() => updateEnhancerPreferences({
                customAccentEnabled: true,
                customAccent: preferences.customAccent ?? ACCENT_PRESETS.violet,
              })}
              style={[styles.accentOption, {
                borderColor: preferences.customAccentEnabled ? tokens.accent : tokens.borderSubtle,
                backgroundColor: preferences.customAccentEnabled ? tokens.accentBg : tokens.surface2,
              }]}
            >
              <View style={[styles.swatch, { backgroundColor: preferences.customAccent ?? ACCENT_PRESETS.violet }]} />
              <Text style={[styles.accentLabel, { color: preferences.customAccentEnabled ? tokens.accent : tokens.foregroundMuted, fontFamily: tokens.fontUi }]}>{t("settings.accent.custom")}</Text>
            </Pressable>
          </View>
          {preferences.customAccentEnabled ? <CustomAccentPicker value={preferences.customAccent ?? ACCENT_PRESETS.violet} tokens={tokens} /> : null}
        </View>

        <ChoiceRow<UiFontPreference>
          title={t("settings.uiFont.label")}
          description={t("settings.uiFont.description")}
          value={preferences.uiFont}
          options={[
            { value: "inter", label: t("settings.uiFont.inter") },
            { value: "system", label: t("settings.uiFont.system") },
          ]}
          onChange={(uiFont) => updateEnhancerPreferences({ uiFont })}
          tokens={tokens}
        />

        <ChoiceRow<CodeFontPreference>
          title={t("settings.codeGlyphs.label")}
          description={t("settings.codeGlyphs.description")}
          value={preferences.codeFont}
          options={[
            { value: "code", label: t("settings.codeGlyphs.ligatures") },
            { value: "plain", label: t("settings.codeGlyphs.literal") },
          ]}
          onChange={(codeFont) => updateEnhancerPreferences({ codeFont })}
          tokens={tokens}
        />

        <ChoiceRow
          title={t("settings.codeFont.label")}
          description={t("settings.codeFont.description")}
          value={preferences.codeFontFamily}
          options={CODE_FONT_OPTIONS.map(option => ({ ...option, label: t(CODE_FONT_LABELS[option.value]) }))}
          onChange={(codeFontFamily) => updateEnhancerPreferences({ codeFontFamily })}
          tokens={tokens}
        />

        <ChoiceRow
          title={t("settings.textSize.label")}
          description={t("settings.textSize.description")}
          value={String(preferences.textScale)}
          options={TEXT_SIZE_OPTIONS.map(option => ({ ...option, label: t(TEXT_SIZE_LABELS[option.value]) }))}
          onChange={(textScale) => updateEnhancerPreferences({ textScale: Number(textScale) })}
          tokens={tokens}
        />

        {hermesCc.status === "ready" ? (
          <ToggleRow
            title={t("settings.hermesCc.label")}
            description={t("settings.hermesCc.description")}
            value={hermesCc.values.enabled}
            onChange={(enabled) => { void hermesCc.save({ enabled }, hermesCc.revision); }}
            tokens={tokens}
          />
        ) : null}
        {hermesCc.status === "error" || hermesCc.status === "invalid" || hermesCc.saveError ? (
          <SettingsFailureNotice
            message={t("settings.hermesCc.error")}
            onRetry={() => { void hermesCc.reload(); }}
            tokens={tokens}
          />
        ) : null}

        <ToggleRow
          title={t("settings.foldSteps.label")}
          description={t("settings.foldSteps.description")}
          value={preferences.foldFinishedSteps}
          onChange={(foldFinishedSteps) => updateEnhancerPreferences({ foldFinishedSteps })}
          tokens={tokens}
        />

        <ChoiceRow
          title={t("settings.collapsedAction.label")}
          description={t("settings.collapsedAction.description")}
          value={preferences.collapsedStepAction}
          options={[
            { value: "details", label: t("settings.collapsedAction.details") },
            { value: "inline", label: t("settings.collapsedAction.inline") },
          ]}
          onChange={(collapsedStepAction) => updateEnhancerPreferences({ collapsedStepAction })}
          tokens={tokens}
        />

        <ChoiceRow
          title={t("settings.foldOutput.label")}
          description={t("settings.foldOutput.description")}
          value={String(preferences.foldLongOutputAfter)}
          options={OUTPUT_LINE_OPTIONS.map(option => ({ ...option, label: t(OUTPUT_LINE_LABELS[option.value]) }))}
          onChange={(value) => updateEnhancerPreferences({ foldLongOutputAfter: value === "never" ? "never" : Number(value) as OutputLineLimit })}
          tokens={tokens}
        />

        <ToggleRow
          title={t("settings.frosted.label")}
          description={t("settings.frosted.description")}
          value={preferences.frostedGlass}
          onChange={(frostedGlass) => updateEnhancerPreferences({ frostedGlass })}
          tokens={tokens}
        />

        <ToggleRow
          title={t("settings.glow.label")}
          description={t("settings.glow.description")}
          value={preferences.pointerGlow}
          onChange={(pointerGlow) => updateEnhancerPreferences({ pointerGlow })}
          tokens={tokens}
        />

        <ToggleRow
          title={t("settings.promptBubble.label")}
          description={t("settings.promptBubble.description")}
          value={preferences.enhancedUserBubble}
          onChange={(enhancedUserBubble) => updateEnhancerPreferences({ enhancedUserBubble })}
          tokens={tokens}
        />

        <ToggleRow
          title={t("settings.selection.label")}
          description={t("settings.selection.description")}
          value={preferences.selectionActions}
          onChange={(selectionActions) => updateEnhancerPreferences({ selectionActions })}
          tokens={tokens}
        />

        <ToggleRow
          title={t("settings.markdown.label")}
          description={t("settings.markdown.description")}
          value={preferences.assistantMarkdown}
          onChange={(assistantMarkdown) => updateEnhancerPreferences({ assistantMarkdown })}
          tokens={tokens}
        />

        <ChoiceRow
          title={t("settings.markdownStyle.label")}
          description={t("settings.markdownStyle.description")}
          value={preferences.markdownVariant}
          options={[
            { value: "document", label: t("settings.markdownStyle.document") },
            { value: "compact", label: t("settings.markdownStyle.compact") },
            { value: "terminal", label: t("settings.markdownStyle.terminal") },
          ]}
          onChange={(markdownVariant) => updateEnhancerPreferences({ markdownVariant })}
          tokens={tokens}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={resetEnhancerPreferences}
        style={[styles.reset, { borderColor: tokens.borderSubtle }]}
      >
        <Text
          style={[styles.resetText, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}
        >
          {t("settings.reset")}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="link"
        onPress={() => openLink("https://github.com/jasonhnd/paseo-clear-chat/issues/new?template=bug_report.yml")}
        style={[
          styles.card,
          styles.row,
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
  // No `flex: 1` here. The host mounts a settings screen inside a plain
  // column `View` (app `plugins/settings/index.tsx:107`), and React Native Web
  // compiles `flex: 1` to `flex: 1 1 0%` — a zero basis in a container that
  // sizes to its content, so the whole page collapses to nothing.
  container: { alignSelf: "stretch", padding: 16, gap: 12 },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  // The text column takes the slack so a long description wraps instead of
  // pushing the switch off the card.
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
  card: { borderWidth: 1, borderRadius: radius.card, overflow: "hidden" },
  row: { padding: 14, gap: 8, borderTopWidth: 1 },
  rowTitle: { fontSize: 14, fontWeight: "600" },
  rowDescription: { fontSize: 12, lineHeight: 17 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { borderWidth: 1, borderRadius: radius.block, paddingHorizontal: 10, paddingVertical: 7 },
  optionLabel: { fontSize: 12, fontWeight: "600" },
  accentOptions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  accentOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.block,
    paddingHorizontal: 9,
    paddingVertical: 7,
    minHeight: 44,
  },
  customPicker: { minWidth: 0, gap: 8 },
  colourChoice: { minWidth: 44, minHeight: 44, borderWidth: 2, borderRadius: radius.block, alignItems: "center", justifyContent: "center" },
  colourSample: { width: 28, height: 28, borderRadius: radius.chip },
  hexControls: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  hexInput: { flexGrow: 1, flexShrink: 1, flexBasis: 140, minWidth: 0, minHeight: 44, borderWidth: 1, borderRadius: radius.block, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16 },
  applyColour: { minHeight: 44, paddingHorizontal: 16, justifyContent: "center", borderRadius: radius.block },
  swatch: { width: 12, height: 12, borderRadius: radius.chip },
  accentLabel: { fontSize: 12, fontWeight: "600" },
  reset: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: radius.block,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  resetText: { fontSize: 12, fontWeight: "600" },
});
