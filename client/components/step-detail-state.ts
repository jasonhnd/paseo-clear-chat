import { createContext, useCallback, useContext, useEffect, useState, type SetStateAction } from "react";

/** Transient reading state follows one selected step between its presentation roots. */
export interface StepDetailState {
  scrollOffset: number;
  snap: "half" | "full";
  values: Map<string, unknown>;
}

export const createStepDetailState = (): StepDetailState => ({ scrollOffset: 0, snap: "half", values: new Map() });
export const StepDetailStateContext = createContext<StepDetailState | null>(null);

/** Outside details these controls retain their ordinary local React state. */
export function useStepDetailState<T>(key: string, initial: T) {
  const state = useContext(StepDetailStateContext);
  const [value, setValue] = useState<T>(() => state?.values.has(key) ? state.values.get(key) as T : initial);
  useEffect(() => { state?.values.set(key, value); }, [state, key, value]);
  const set = useCallback((action: SetStateAction<T>) => {
    setValue(previous => {
      const next = typeof action === "function" ? (action as (previous: T) => T)(previous) : action;
      state?.values.set(key, next);
      return next;
    });
  }, [state, key]);
  return [value, set] as const;
}
