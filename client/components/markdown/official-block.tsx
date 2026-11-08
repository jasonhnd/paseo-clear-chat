import React from "react";
import * as PaseoUI from "@getpaseo/plugin/client/ui";

const { Markdown } = PaseoUI as typeof PaseoUI & {
  Markdown?: (props: { children: string }) => React.ReactElement;
};

export function fencedSource(code: string, language: string): string {
  let longest = 0;
  for (const run of code.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code.replace(/(?:\r?\n)+$/, "")}\n${fence}`;
}

class MarkdownBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function OfficialMarkdownBlock({ text, fallback }: { text: string; fallback: React.ReactNode }) {
  if (typeof Markdown !== "function") return fallback;
  return <MarkdownBoundary key={text} fallback={fallback}><Markdown>{text}</Markdown></MarkdownBoundary>;
}
