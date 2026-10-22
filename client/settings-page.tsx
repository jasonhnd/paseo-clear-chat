import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { customAccentSchema } from "../shared/settings";
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

const TRACK_WIDTH = 38;
const TRACK_HEIGHT = 22;
const KNOB = 16;

const CUSTOM_SWATCHES = ["#e63946", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

function CustomAccentPicker({ value, tokens }: { value: string; tokens: ExtendedThemeTokens }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(value); setError(null); }, [value]);
  const choose = (hex: string) => {
    setDraft(hex);
    setError(null);
    return updateEnhancerPreferences({ customAccent: hex, customAccentEnabled: true });
  };
  const apply = () => {
    const result = customAccentSchema.safeParse(draft);
    if (!result.success) {
      setError("Enter a HEX colour as #RGB or #RRGGBB.");
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
            accessibilityLabel={`Use accent ${hex}`}
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
          accessibilityLabel="Custom HEX colour"
          accessibilityHint="Enter #RGB or #RRGGBB, then apply the colour."
          value={draft}
          onChangeText={(text) => { setDraft(text); setError(null); }}
          onSubmitEditing={apply}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder="#RRGGBB"
          placeholderTextColor={tokens.foregroundMuted}
          returnKeyType="done"
          style={[styles.hexInput, { color: tokens.foreground, borderColor: error ? tokens.danger : tokens.border, fontFamily: tokens.fontMono }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Apply custom accent"
          onPress={apply}
          style={[styles.applyColour, { backgroundColor: tokens.accent }]}
        >
          <Text style={[styles.accentLabel, { color: tokens.accentForeground, fontFamily: tokens.fontUi }]}>Apply</Text>
        </Pressable>
      </View>
      {error ? <Text accessibilityRole="alert" style={[styles.rowDescription, { color: tokens.foreground, fontFamily: tokens.fontUi }]}>{error}</Text> : null}
      <Text style={[styles.rowDescription, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}>
        The saved HEX stays unchanged. For readable text, we darken it on light themes or lighten it on dark themes until contrast is at least 4.5:1 on plugin surfaces. Filled buttons use black or white text, whichever has higher contrast. Midtone themes may use solid backgrounds to keep that contrast.
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
          Chat presentation
        </Text>
        <Text
          style={[styles.description, { color: tokens.foregroundMuted, fontFamily: tokens.fontUi }]}
        >
          Changes are saved on the selected host and shared by its clients. New messages follow
          rendering changes; reload the chat to update existing messages. Accent colours update immediately.
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
            Accent colour
          </Text>
          <Text
            style={[
              styles.rowDescription,
              { color: tokens.foregroundMuted, fontFamily: tokens.fontUi },
            ]}
          >
            Use the current Paseo theme, or choose a presentation accent.
          </Text>
          <View style={styles.accentOptions}>
            {ACCENT_OPTIONS.map((option) => {
              const selected = !preferences.customAccentEnabled && preferences.accent === option.id;
              const swatch = option.color ?? theme.colors.accent;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Accent: ${option.label}`}
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
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Accent: Custom"
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
              <Text style={[styles.accentLabel, { color: preferences.customAccentEnabled ? tokens.accent : tokens.foregroundMuted, fontFamily: tokens.fontUi }]}>Custom</Text>
            </Pressable>
          </View>
          {preferences.customAccentEnabled ? <CustomAccentPicker value={preferences.customAccent ?? ACCENT_PRESETS.violet} tokens={tokens} /> : null}
        </View>

        <ChoiceRow<UiFontPreference>
          title="Interface font"
          description="Choose the embedded Inter face or the system interface face."
          value={preferences.uiFont}
          options={[
            { value: "inter", label: "Inter" },
            { value: "system", label: "System" },
          ]}
          onChange={(uiFont) => updateEnhancerPreferences({ uiFont })}
          tokens={tokens}
        />

        <ChoiceRow<CodeFontPreference>
          title="Code glyphs"
          description="For Iosevka, use programming ligatures inside syntax blocks or keep glyphs literal. Other fonts use their own glyphs."
          value={preferences.codeFont}
          options={[
            { value: "code", label: "Ligatures" },
            { value: "plain", label: "Literal" },
          ]}
          onChange={(codeFont) => updateEnhancerPreferences({ codeFont })}
          tokens={tokens}
        />

        <ChoiceRow
          title="Code font"
          description="Paseo's code font is not exposed by the plugin SDK. Default (Iosevka) uses Iosevka and your Code glyphs choice. Other fonts must be installed on web or desktop; missing fonts use Iosevka. iOS and Android use platform monospace."
          value={preferences.codeFontFamily}
          options={CODE_FONT_OPTIONS}
          onChange={(codeFontFamily) => updateEnhancerPreferences({ codeFontFamily })}
          tokens={tokens}
        />

        <ChoiceRow
          title="Text size"
          description="Scales the text this plugin draws, from replies and code blocks to callouts and badges. Saved on this host for all your devices."
          value={String(preferences.textScale)}
          options={TEXT_SIZE_OPTIONS}
          onChange={(textScale) => updateEnhancerPreferences({ textScale: Number(textScale) })}
          tokens={tokens}
        />

        <ToggleRow
          title="Fold finished steps"
          description="Collapse finished tool calls by default. Turning this off expands every step. Saved choices for individual calls take precedence."
          value={preferences.foldFinishedSteps}
          onChange={(foldFinishedSteps) => updateEnhancerPreferences({ foldFinishedSteps })}
          tokens={tokens}
        />

        <ChoiceRow
          title="Fold long output after"
          description="Preview long tool output, reply code and prompts with a button to reveal every line."
          value={String(preferences.foldLongOutputAfter)}
          options={OUTPUT_LINE_OPTIONS}
          onChange={(value) => updateEnhancerPreferences({ foldLongOutputAfter: value === "never" ? "never" : Number(value) as OutputLineLimit })}
          tokens={tokens}
        />

        <ToggleRow
          title="Frosted glass"
          description="Blur surfaces where the host supports it, or use solid surfaces instead."
          value={preferences.frostedGlass}
          onChange={(frostedGlass) => updateEnhancerPreferences({ frostedGlass })}
          tokens={tokens}
        />

        <ToggleRow
          title="Pointer glow"
          description="A soft light follows the pointer across each card. Desktop and web only: touch platforms have no hover, and the light is skipped when the system asks for reduced motion."
          value={preferences.pointerGlow}
          onChange={(pointerGlow) => updateEnhancerPreferences({ pointerGlow })}
          tokens={tokens}
        />

        <ToggleRow
          title="Enhanced prompt bubble"
          description="Paseo removes pasted images before a plugin sees the message, so the enhanced bubble cannot show them. Turn this off for Paseo's own bubble with image previews. New prompts follow the change. On iOS, text cannot be selected by dragging when this is enabled. Use the Copy button to copy text."
          value={preferences.enhancedUserBubble}
          onChange={(enhancedUserBubble) => updateEnhancerPreferences({ enhancedUserBubble })}
          tokens={tokens}
        />

        <ToggleRow
          title="Selection actions"
          description="Highlighting text in a callout raises a small bar with Copy and Add to chat. Add to chat drops the highlight into the composer as a quote, or a fenced block when it came from code. Desktop and web only: iOS and Android use the platform's own selection menu."
          value={preferences.selectionActions}
          onChange={(selectionActions) => updateEnhancerPreferences({ selectionActions })}
          tokens={tokens}
        />

        <ToggleRow
          title="Assistant markdown"
          description="Draws the reply with the plugin's own headings, lists and syntax-highlighted code blocks. The plugin cannot reach Paseo's markdown pipeline, so its version is a subset: turn this off for mermaid diagrams, images, and the host's file-path links. On iOS, text cannot be selected by dragging when this is enabled. Use the Copy button to copy text."
          value={preferences.assistantMarkdown}
          onChange={(assistantMarkdown) => updateEnhancerPreferences({ assistantMarkdown })}
          tokens={tokens}
        />

        <ChoiceRow
          title="Markdown style"
          description="Document is airy and built for long answers. Compact tightens the spacing for short replies. Terminal sets the body in the code face."
          value={preferences.markdownVariant}
          options={[
            { value: "document", label: "Document" },
            { value: "compact", label: "Compact" },
            { value: "terminal", label: "Terminal" },
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
          Reset defaults
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
          Report a problem
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
