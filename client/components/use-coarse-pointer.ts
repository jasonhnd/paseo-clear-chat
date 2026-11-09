import { useEffect, useState } from "react";

/** Track the primary pointer without consulting browser APIs on native. */
export function useCoarsePointer(enabled = true): boolean {
  const query = () => enabled && typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)")
    : null;
  const [coarse, setCoarse] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const media = query();
    if (!media) {
      setCoarse(false);
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    setCoarse(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [enabled]);

  return coarse;
}
