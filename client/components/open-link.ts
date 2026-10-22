import { Linking, Platform } from "react-native";

/**
 * Opens an HTTP(S) or mailto link on the client where it was pressed.
 *
 * Three sinks, in the host's own order of preference
 * (`app/src/utils/open-external-url.ts`):
 *
 * 1. On Electron the desktop bridge (`window.paseoDesktop.opener.openUrl`,
 *    read in `desktop/electron/host.ts:7`) hands the URL to the OS browser.
 *    Without it a link opens inside the app window, which has no chrome to
 *    navigate back from.
 * 2. On plain web, `window.open` with `noopener,noreferrer`.
 * 3. On iOS (including iPadOS) and Android, the host-injected
 *    `react-native` module supplies `Linking.openURL(url)`. The plugin SDK
 *    needs no separate Android opener. Call it directly: a `canOpenURL`
 *    preflight can reject on Android 11+ without manifest intent queries.
 *
 * Reply links also permit mailto. A link in a model's reply is untrusted
 * input, and `javascript:` or `file:` must never reach a sink.
 */
const ALLOWED = new Set(["http:", "https:", "mailto:"]);

interface DesktopOpener {
  opener?: { openUrl?: (url: string) => unknown };
}

function allowed(url: string): boolean {
  try {
    return ALLOWED.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export async function openLink(url: string): Promise<void> {
  if (!allowed(url)) return;

  try {
    if (Platform.OS === "web") {
      const opener = (globalThis as { paseoDesktop?: DesktopOpener }).paseoDesktop?.opener;
      if (typeof opener?.openUrl === "function") {
        try {
          await opener.openUrl(url);
          return;
        } catch {
          // An unavailable desktop bridge can still use the browser fallback.
        }
      }
      globalThis.open?.(url, "_blank", "noopener,noreferrer");
      return;
    }

    await Linking.openURL(url);
  } catch {
    // Opening can be denied or have no registered handler on this client.
  }
}
