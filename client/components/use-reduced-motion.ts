import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

const query = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => Platform.OS === "web"
    ? typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
    : true);

  useEffect(() => {
    if (Platform.OS === "web") {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
      const media = window.matchMedia(query);
      const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
      media.addEventListener("change", onChange);
      setReduced(media.matches);
      return () => media.removeEventListener("change", onChange);
    }

    let active = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", value => {
      changed = true;
      setReduced(value);
    });
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (active && !changed) setReduced(value);
    }).catch(() => {});
    return () => { active = false; subscription.remove(); };
  }, []);

  return reduced;
}
