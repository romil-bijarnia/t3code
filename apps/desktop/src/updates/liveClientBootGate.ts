/** The stable preload must guard a trial even when its new bootstrap never executes. */
export function freezeLiveClientTrial(document: Document, version: string): () => void {
  let observer: MutationObserver | undefined;
  const apply = () => {
    if (document.documentElement) document.documentElement.dataset.liveClientTrial = version;
    if (!document.body) return false;
    document.body.inert = true;
    observer?.disconnect();
    return true;
  };
  if (!apply()) {
    observer = new MutationObserver(apply);
    observer.observe(document, { childList: true, subtree: true });
  }
  return () => observer?.disconnect();
}
