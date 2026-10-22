import { Platform } from "react-native";

let nextEntry = 0;

/** Give browser Back the same dismiss-first behavior as Android's modal Back. */
export function installStepDetailBack(onBack: () => void): () => void {
  if (Platform.OS !== "web" || typeof window === "undefined") return () => {};
  const marker = `step-detail-${++nextEntry}`;
  let active = true;
  const previous = window.history.state;
  try {
    window.history.pushState({ ...previous, clearChatStepDetail: marker }, "");
  } catch {
    return () => {};
  }
  const onPop = () => {
    if (!active) return;
    active = false;
    onBack();
  };
  window.addEventListener("popstate", onPop);
  return () => {
    window.removeEventListener("popstate", onPop);
    if (active && window.history.state?.clearChatStepDetail === marker) {
      active = false;
      window.history.back();
    }
  };
}
