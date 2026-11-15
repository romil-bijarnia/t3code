let count = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // An update observer must never fail the command or recording it watches.
    }
  }
}

export function retainLiveClientWork(): () => void {
  let released = false;
  count += 1;
  notify();
  return () => {
    if (released) return;
    released = true;
    count -= 1;
    notify();
  };
}

export function getLiveClientWorkCount(): number {
  return count;
}

export function subscribeLiveClientWork(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
