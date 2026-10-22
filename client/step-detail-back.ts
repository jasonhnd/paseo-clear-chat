import { Platform } from "react-native";

let nextEntry = 0;
let pendingRestore: Promise<void> | undefined;

/** Give browser Back the same dismiss-first behavior as Android's modal Back. */
export function installStepDetailBack(onBack: () => void): () => void {
  if (Platform.OS !== "web" || typeof window === "undefined") return () => {};
  const marker = `step-detail-${++nextEntry}`;
  let active = true;
  let inserted = false;
  const onPop = () => {
    if (!active) return;
    active = false;
    onBack();
  };
  const insert = () => {
    if (!active) return;
    try {
      window.history.pushState({ ...window.history.state, clearChatStepDetail: marker }, "");
      inserted = true;
      window.addEventListener("popstate", onPop);
    } catch {
      // Restricted browser history leaves the explicit dismiss controls available.
    }
  };
  // A close traversal is asynchronous. Reopening must not treat its popstate as
  // Back for the newly opened step, or leave an extra entry on the host route.
  if (pendingRestore) void pendingRestore.then(insert); else insert();
  return () => {
    window.removeEventListener("popstate", onPop);
    if (active && inserted && window.history.state?.clearChatStepDetail === marker) {
      let finish!: () => void;
      const restore = new Promise<void>(resolve => { finish = resolve; });
      pendingRestore = restore;
      const restored = () => {
        window.removeEventListener("popstate", restored);
        if (pendingRestore === restore) pendingRestore = undefined;
        finish();
      };
      window.addEventListener("popstate", restored);
      window.history.back();
    }
    active = false;
  };
}
