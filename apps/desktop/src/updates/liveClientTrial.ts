const trials = new Map<number, Set<symbol>>();

export const hasLiveClientTrial = (contentsId: number): boolean => trials.has(contentsId);

export function retainLiveClientTrial(contentsId: number): () => void {
  const token = Symbol();
  const owners = trials.get(contentsId) ?? new Set<symbol>();
  owners.add(token);
  trials.set(contentsId, owners);
  return () => {
    owners.delete(token);
    if (owners.size === 0 && trials.get(contentsId) === owners) trials.delete(contentsId);
  };
}
