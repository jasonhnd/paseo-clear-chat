import React from "react";
import * as pluginClient from "@getpaseo/plugin/client";
import * as pluginUi from "@getpaseo/plugin/client/ui";
import { messages } from "../messages";

/**
 * Phrasing presets for the text this plugin puts into the composer. The host owns
 * where the control is drawn: inline when the composer has room, in its overflow
 * sheet on a phone. We only own the choice.
 *
 * These are 0.16 API surfaces (`addComposerItem`, `useComposer`, `Select`); an
 * older host has none of them, so everything is looked up at runtime and the
 * control simply does not register there.
 */
export const ANSWER_STYLES = ["recommended", "brief", "detailed"] as const;
export type AnswerStyle = (typeof ANSWER_STYLES)[number];

type HostComposer = {
  readonly context: "agent" | "draft" | "new-workspace";
  readonly prompt: string;
  insertText(text: string): void;
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

let currentStyle: AnswerStyle = "recommended";

export function getAnswerStyle(): AnswerStyle {
  return currentStyle;
}

export function setAnswerStyle(style: AnswerStyle): void {
  currentStyle = style;
}

/**
 * Shape the text this plugin inserts into the composer. `recommended` keeps it as
 * written; `brief` keeps the first non-empty line; `detailed` keeps every line.
 * Nothing here ever sends.
 */
export function composeAnswerText(base: string, style: AnswerStyle = currentStyle): string {
  const text = base.trim();
  if (!text) return "";
  if (style === "brief") {
    const first = text.split("\n").map(line => line.trim()).find(line => line.length > 0);
    return first ?? "";
  }
  return text;
}

/** Put the styled text into the composer without sending it. */
export function insertAnswer(composer: Pick<HostComposer, "insertText"> | null, base: string, style: AnswerStyle = currentStyle): string {
  const text = composeAnswerText(base, style);
  if (!composer || !text) return text;
  composer.insertText(text);
  return text;
}

export function AnswerStyleControl() {
  const composer = useHostComposer?.();
  const { t } = pluginClient.useTranslation(messages);
  const [style, setStyle] = React.useState<AnswerStyle>(currentStyle);
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
        setStyle(value);
        setAnswerStyle(value);
      }}
    />
  );
}
