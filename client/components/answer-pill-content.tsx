import React from "react";
import { Text } from "react-native";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useAgent, useTranslation } from "@getpaseo/plugin/client";
import { useCurrentPillCard } from "../answer-pill";
import { useOptionSession } from "../option-session";
import { messages } from "../messages";
import { useEnhancerPreferences } from "../preferences";
import { buildThemeTokens } from "./theme-tokens";
import { OptionCard } from "./option-card";

/**
 * The whole answer card, drawn where the host opens a composer pill.
 *
 * The host surface is the scroll container (max 440 high, a sheet on compact layouts), so the
 * card keeps no timeline spacing of its own and no footer of its own. Sending goes to the
 * host's message API (`option-session` keeps its sender), not through this popover.
 *
 * The card body refuses to draw while the agent is answering, because answers chosen then
 * would race the reply. The popover explains that instead of opening onto an empty sheet.
 *
 * The host marks a compact layout as a bottom sheet, where the card drops the keyboard hint.
 */
export function AnswerPillContent(props: PluginButtonContentProps) {
  const { t } = useTranslation(messages);
  const agentId = props.context === "agent" ? props.agentId : null;
  const compact = props.layout?.compact === true;
  const card = useCurrentPillCard(agentId ?? "");
  const session = useOptionSession(agentId ?? "", card?.at);
  const status = useAgent(agentId ?? "", agent => agent.status);
  const preferences = useEnhancerPreferences();
  const tokens = React.useMemo(() => buildThemeTokens(props.theme.colors, preferences), [props.theme, preferences]);
  if (!agentId || !card) return null;
  if (status === "running" && session && !session.readOnly) {
    return <Text testID="option-pill-waiting" style={{ color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(13), paddingVertical: 8 }}>{t("answerCard.waitingForReply")}</Text>;
  }
  return <OptionCard agentId={agentId} at={card.at} tokens={tokens} surface="popover" compact={compact} />;
}
