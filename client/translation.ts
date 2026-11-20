import type { PluginClientContext, useTranslation } from "@getpaseo/plugin/client";
import { messages } from "./messages";

export type Translate = ReturnType<typeof useTranslation<typeof messages.resources.en>>["t"];
type DiagnosticKey = `startup.${keyof typeof messages.resources.en.startup}`;
let clientI18n: PluginClientContext["i18n"] | undefined;

/** Pure data helpers also work before registration, with their original English output. */
export const translate: Translate = (key, ...args) => {
  if (clientI18n) return clientI18n.t(messages, key, ...args);
  const options = args[0];
  const values = options?.replace as Record<string, unknown> | undefined ?? options;
  const source = key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], messages.resources.en) as string;
  return source.replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name]));
};

/** Callbacks and DOM surfaces resolve against the connected app at invocation time. */
export function initializeClientTranslations(client: PluginClientContext): void {
  clientI18n = client.i18n;
}

/** Only fixed, plugin-owned diagnostics are translated; provider errors stay verbatim. */
export function translatedDiagnostic(text: string, t: Translate = translate): string {
  const resource = messages.resources.en.startup;
  for (const [name, english] of Object.entries(resource)) {
    if (text === english) return t(`startup.${name}` as DiagnosticKey);
  }
  return text;
}
