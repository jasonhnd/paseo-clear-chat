import React from "react";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useCurrentPillCard } from "../answer-pill";
import { useEnhancerPreferences } from "../preferences";
import { buildThemeTokens } from "./theme-tokens";
import { OptionCard } from "./option-card";

/**
 * The whole answer card, drawn where the host opens a composer pill.
 *
 * The host surface is the scroll container (max 440 high, a sheet on compact layouts), so the
 * card keeps no timeline spacing of its own and no footer of its own. Sending goes to the
 * host's message API (`option-session` keeps its sender), not through this popover.
 */
export function AnswerPillContent(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : null;
  const card = useCurrentPillCard(agentId ?? "");
  const preferences = useEnhancerPreferences();
  const tokens = React.useMemo(() => buildThemeTokens(props.theme.colors, preferences), [props.theme, preferences]);
  if (!agentId || !card) return null;
  return <OptionCard agentId={agentId} at={card.at} tokens={tokens} surface="popover" />;
}
