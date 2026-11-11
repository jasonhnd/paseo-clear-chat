import React from "react";
import * as pluginClient from "@getpaseo/plugin/client";
import * as pluginUi from "@getpaseo/plugin/client/ui";
import { messages } from "../messages";
import { getEnhancerPreferences, updateEnhancerPreferences, useEnhancerPreferences } from "../preferences";

/**
 * Phrasing presets for the text this plugin puts into the composer. The host owns
 * where the control is drawn: inline when the composer has room, in its overflow
 * sheet on a phone. We only own the choice.
 *
 * These are 0.16 API surfaces (`addComposerItem`, `useComposer`, `Select`); an
 * older host has none of them, so everything is looked up at runtime and the
 * control simply does not register there.
 */
export const ANSWER_STYLES = ["none", "concise", "formal", "casual", "oneLine"] as const;
export type AnswerStyle = (typeof ANSWER_STYLES)[number];

type HostComposer = {
  readonly context: "agent" | "draft" | "new-workspace";
  readonly prompt: string;
};

type HostSelectProps = {
  title: string;
  icon: string;
  disabled?: boolean;
  value: AnswerStyle;
  options: readonly { value: AnswerStyle; label: string; description?: string }[];
  onValueChange(event: { value: AnswerStyle }): void | Promise<void>;
};

const useHostComposer = (pluginClient as unknown as { useComposer?: () => HostComposer }).useComposer;
const HostSelect = (pluginUi as unknown as { Select?: React.ComponentType<HostSelectProps> }).Select;

/** True when the host exposes the 0.16 composer-item API. */
export function answerStyleSupported(client: unknown): boolean {
  return typeof (client as { addComposerItem?: unknown } | null)?.addComposerItem === "function";
}

export function getAnswerStyle(): AnswerStyle {
  return getEnhancerPreferences().answerStyle;
}

export function setAnswerStyle(style: AnswerStyle): void {
  void updateEnhancerPreferences({ answerStyle: style });
}

const styleInstructions = {
  en: { concise: "Answer briefly.", formal: "Use a formal tone.", casual: "Use a casual tone.", oneLine: "Answer in one sentence." },
  "zh-CN": { concise: "请简洁回答。", formal: "请用正式语气。", casual: "请用口语。", oneLine: "请一句话回答。" },
} as const;

/** Append only to the inserted answer's first line; do not alter existing text. */
export function composeAnswerText(base: string, style: AnswerStyle = getAnswerStyle(), locale = "en"): string {
  const text = base.trim();
  if (!text || style === "none") return text;
  const translations = locale.toLowerCase().startsWith("zh") ? styleInstructions["zh-CN"] : styleInstructions.en;
  const instruction = translations[style];
  const newline = text.indexOf("\n");
  return newline < 0 ? `${text} ${instruction}` : `${text.slice(0, newline)} ${instruction}${text.slice(newline)}`;
}

export function AnswerStyleControl() {
  const composer = useHostComposer?.();
  const { t } = pluginClient.useTranslation(messages);
  const style = useEnhancerPreferences().answerStyle;
  if (!HostSelect) return null;
  // A workspace still being created locks its composer; the host draws the control
  // disabled and nothing may be written into the prompt.
  const locked = composer?.context === "new-workspace";
  return (
    <HostSelect
      title={t("answerStyle.title")}
      icon="MessageSquareText"
      disabled={locked}
      value={style}
      options={ANSWER_STYLES.map(value => ({ value, label: t(`answerStyle.${value}` as const) }))}
      onValueChange={({ value }) => {
        if (locked) return;
        setAnswerStyle(value);
      }}
    />
  );
}
