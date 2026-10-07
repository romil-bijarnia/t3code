import { useCallback, useSyncExternalStore } from "react";

/**
 * Which Spaces and pages are unfolded in the sidebar. Remembered per browser
 * the way ChatGPT does it, so the tree looks the same after a restart.
 */
const STORAGE_KEY = "t3code:space-tree:v1";

let state: Readonly<Record<string, boolean>> = load();
const listeners = new Set<() => void>();

function load(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "boolean"),
    ) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function persist() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private windows and blocked storage simply forget between sessions.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSpaceTreeExpanded(key: string, expanded: boolean) {
  if (state[key] === expanded) return;
  state = { ...state, [key]: expanded };
  persist();
  for (const listener of listeners) listener();
}

export function useSpaceTreeExpanded(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  const expanded = useSyncExternalStore(
    subscribe,
    () => state[key] ?? fallback,
    () => fallback,
  );
  const set = useCallback((next: boolean) => setSpaceTreeExpanded(key, next), [key]);
  return [expanded, set];
}
