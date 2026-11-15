import { useLayoutEffect, useSyncExternalStore } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { acknowledgeLiveClientBoot } from "../lib/liveClientBoot";

function subscribeComposerHydration(changed: () => void): () => void {
  const beginning = useComposerDraftStore.persist.onHydrate(changed);
  const complete = useComposerDraftStore.persist.onFinishHydration(changed);
  return () => {
    beginning();
    complete();
  };
}

export function LiveClientBootAcknowledgement({ ready }: { readonly ready: boolean }) {
  const hydrated = useSyncExternalStore(
    subscribeComposerHydration,
    useComposerDraftStore.persist.hasHydrated,
    () => false,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A connected, hydrated chat view acknowledges the trial before the host permits user input.
  useLayoutEffect(() => {
    if (ready && hydrated) void acknowledgeLiveClientBoot();
  }, [ready, hydrated]);
  return null;
}
