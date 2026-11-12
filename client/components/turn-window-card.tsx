import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { turnWindowRpc } from "../../shared/turn-window-rpc";
import type { ExtendedThemeTokens } from "./theme-tokens";

type Result = { files: string[]; message: string | null; warning: string | null; incomplete: boolean };
const incomplete: Result = { files: [], message: "Snapshot timing or overlap with other conversations may be incomplete.", warning: null, incomplete: true };

type Reply = { type: "assistant"; text: string; messageId?: string } | { type: "tool"; callId?: string; name: string };

export function TurnWindowCard({ agentId, at, reply, tokens }: { agentId: string; at: Date; reply: Reply; tokens: ExtendedThemeTokens }) {
  const paseo = usePaseo();
  const getWindow = useRpc(turnWindowRpc);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const show = async () => {
    const generation = ++request.current;
    if (open) { setOpen(false); return; }
    setOpen(true);
    setResult(null);
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 0, projection: "canonical" });
      if (page.error || page.hasOlder || page.hasNewer) throw new Error("Incomplete timeline");
      const matches = page.entries.filter(entry => Date.parse(entry.timestamp) === at.getTime() && (
        reply.type === "assistant" ? entry.item.type === "assistant_message" && (reply.messageId ? entry.item.messageId === reply.messageId : entry.item.text === reply.text)
          : entry.item.type === "tool_call" && entry.item.name === reply.name && entry.item.callId === reply.callId));
      const turnId = matches[0]?.turnId;
      const valid = Boolean(turnId) && matches.every(entry => entry.turnId === turnId);
      const value = valid && turnId ? await getWindow({ agentId, turnId }) : incomplete;
      if (generation === request.current) setResult(value);
    } catch { if (generation === request.current) setResult(incomplete); }
  };
  return <View testID="turn-window-card" style={{ marginTop: 8, padding: 10, borderWidth: 1, borderColor: tokens.border, borderRadius: 8 }}>
    <Pressable testID="turn-window-toggle" accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { void show(); }}>
      <Text style={{ color: tokens.foreground, fontSize: tokens.fs(12) }}>Workspace changes during this turn {open ? "▴" : "▾"}</Text>
    </Pressable>
    {open ? <View style={{ gap: 4, marginTop: 8 }}>
      {!result ? <Text style={{ color: tokens.foregroundMuted }}>Loading…</Text> : <>
        {result.message ? <Text selectable style={{ color: tokens.foregroundMuted }}>{result.message}</Text> : null}
        {result.warning ? <Text selectable style={{ color: tokens.foregroundMuted }}>{result.warning}</Text> : null}
        {result.incomplete && !result.message ? <Text selectable style={{ color: tokens.foregroundMuted }}>{incomplete.message}</Text> : null}
        {result.files.map(file => <Text selectable key={file} style={{ color: tokens.foreground }}>{file}</Text>)}
        {!result.message && !result.files.length ? <Text style={{ color: tokens.foregroundMuted }}>No differences observed.</Text> : null}
      </>}
    </View> : null}
  </View>;
}
