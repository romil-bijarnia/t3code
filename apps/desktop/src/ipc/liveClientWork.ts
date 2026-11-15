let active = 0;
const idleListeners = new Set<() => void>();

export function subscribeDesktopClientIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => {
    idleListeners.delete(listener);
  };
}

export const hasPendingDesktopClientWork = () => active > 0;

export function retainDesktopClientWork(): () => void {
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    if (active === 0) for (const listener of idleListeners) listener();
  };
}
