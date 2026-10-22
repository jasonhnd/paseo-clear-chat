import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";

/** Transient reading state follows one selected step between its presentation roots. */
export interface StepDetailState {
  scrollOffset: number;
  snap: "half" | "full";
  values: Map<string, unknown>;
}

export const createStepDetailState = (): StepDetailState => ({ scrollOffset: 0, snap: "half", values: new Map() });
export const StepDetailStateContext = createContext<StepDetailState | null>(null);

interface DetailSession {
  key: string;
  open: boolean;
  state: StepDetailState;
  listeners: Set<() => void>;
}

// Only open overlays need an owner beyond their current timeline row.
const openSessions = new Map<string, DetailSession>();

/** The host recreates timeline rows when entering or leaving its compact layout. */
export function useStepDetailSession(key: string, hostedState?: StepDetailState, reclaimHosted = false) {
  const local = useRef<DetailSession | null>(null);
  if (local.current?.key !== key) local.current = openSessions.get(key) ?? {
    key, open: Boolean(hostedState && reclaimHosted), state: hostedState ?? createStepDetailState(), listeners: new Set(),
  };
  const session = local.current;
  const subscribe = useCallback((listener: () => void) => {
    session.listeners.add(listener);
    if (session.open) openSessions.set(key, session);
    return () => {
      session.listeners.delete(listener);
      // Eviction runs after React's commit so a replacement row can claim the
      // same session. Restoration itself is synchronous, with no refresh timer.
      queueMicrotask(() => {
        if (!session.listeners.size && openSessions.get(key) === session) openSessions.delete(key);
      });
    };
  }, [key, session]);
  const open = useSyncExternalStore(subscribe, () => session.open, () => session.open);
  const setOpen = useCallback((value: boolean) => {
    if (session.open === value) return;
    session.open = value;
    if (value) openSessions.set(key, session);
    else if (openSessions.get(key) === session) openSessions.delete(key);
    for (const listener of session.listeners) listener();
  }, [key, session]);
  return { open, setOpen, state: session.state };
}

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
