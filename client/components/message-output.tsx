import React, { type ReactNode } from "react";
import { useToolExpansion } from "../tool-expansion";
import type { ToolExpansionIdentity } from "../tool-expansion-store";
import { ToolOutput } from "./tool-output";
import type { ExtendedThemeTokens } from "./theme-tokens";

interface MessageOutputProps {
  text: string;
  tokens: ExtendedThemeTokens;
  identity?: ToolExpansionIdentity;
  part: string;
  children: (shown: string) => ReactNode;
}

function SavedMessageOutput({ identity, part, ...props }: MessageOutputProps & { identity: ToolExpansionIdentity }) {
  const expansion = useToolExpansion({
    ...identity,
    // Separate each message and Markdown block from tool row disclosure keys.
    callId: JSON.stringify(["message-output", identity.name, identity.callId ?? "", part]),
  }, false);
  return <ToolOutput {...props} expansion={expansion} />;
}

/** The same preview works in standalone components and persisted timeline items. */
export function MessageOutput(props: MessageOutputProps) {
  return props.identity
    ? <SavedMessageOutput {...props} identity={props.identity} />
    : <ToolOutput text={props.text} tokens={props.tokens}>{props.children}</ToolOutput>;
}
