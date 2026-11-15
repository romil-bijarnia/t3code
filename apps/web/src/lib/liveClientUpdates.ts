import {
  getLiveClientWorkCount,
  subscribeLiveClientWork,
} from "@t3tools/client-runtime/state/live-client-work";
import type { DesktopLiveClientUpdateState } from "@t3tools/contracts";

import {
  composerDraftHasUserContent,
  flushComposerDraftStorage,
  useComposerDraftStore,
} from "../composerDraftStore";
import { isClientSettingsHydrated, subscribeClientSettingsHydration } from "../hooks/useSettings";
import {
  usePendingUserInputAnswers,
  usePendingUserInputQuestionIndex,
  useQuestionAttachmentPreparation,
} from "../questionAttachments";
import { useRightPanelStore } from "../rightPanelStore";
import type { AppRouter } from "../router";
import { useAttachmentUploadStore } from "./attachmentUploadQueue";
import { navigateToLiveClientTrial } from "./liveClientBoot";
import { createLiveClientUpdateSafety, hasLiveClientDocumentRisk } from "./liveClientUpdateSafety";

/** Unsafe renderer state defers navigation; backend-owned running work is deliberately not read. */
export function startLiveClientUpdates(
  router: AppRouter,
  initialState?: DesktopLiveClientUpdateState,
): () => void {
  const bridge = window.desktopBridge?.liveClientUpdates;
  if (!bridge || initialState?.phase === "disabled") return () => {};
  let disposed = false;
  let scheduled = false;
  let attempting = false;
  let initializing = true;
  let guard: ReturnType<typeof createLiveClientUpdateSafety> | null = null;
  let state: DesktopLiveClientUpdateState | null = null;
  let unsubscribeBridge = () => {};
  const requestAttempt = () => {
    if (disposed || scheduled || attempting || state?.phase !== "ready") return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void attempt();
    });
  };
  const createGuard = () =>
    createLiveClientUpdateSafety({
      events: window,
      documentHasRisk: () => hasLiveClientDocumentRisk(document),
      flush: flushComposerDraftStorage,
      readFacts: () => {
        const drafts = useComposerDraftStore.getState();
        const work = getLiveClientWorkCount() > 0;
        return {
          desktop: true,
          supportedRoute: router.state.matches.some(
            (match) => match.routeId === "/_chat/$environmentId/$threadId",
          ),
          hydrated: useComposerDraftStore.persist.hasHydrated() && isClientSettingsHydrated(),
          persistenceReady: useComposerDraftStore.persist.hasHydrated(),
          hasComposerContent: Object.values(drafts.draftsByThreadKey).some(
            composerDraftHasUserContent,
          ),
          hasQuestionDraft:
            Object.keys(usePendingUserInputAnswers.getState()).length > 0 ||
            Object.keys(usePendingUserInputQuestionIndex.getState()).length > 0,
          hasAttachmentPreparation:
            Object.values(useQuestionAttachmentPreparation.getState().counts).some(
              (count) => count > 0,
            ) ||
            Object.values(useAttachmentUploadStore.getState().uploadsByImageId).some(
              (upload) => upload.status !== "ready",
            ),
          hasRendererMutation:
            work ||
            Object.keys(drafts.backgroundSubmissionThreadKeys).length > 0 ||
            drafts.rewindingThreadKeys.size > 0,
          hasRecording: work,
          hasUnsafePanel:
            Object.values(useRightPanelStore.getState().byThreadKey).some(
              (panel) => panel.isOpen,
            ) ||
            Object.values(useRightPanelStore.getState().threadPanelVisibilityByThreadKey).some(
              (panel) => panel.inlineOpen || panel.popoverOpen,
            ),
        };
      },
      subscribe: (changed) => {
        const disposers = [
          useComposerDraftStore.subscribe(changed),
          useComposerDraftStore.persist.onFinishHydration(changed),
          usePendingUserInputAnswers.subscribe(changed),
          usePendingUserInputQuestionIndex.subscribe(changed),
          useQuestionAttachmentPreparation.subscribe(changed),
          useAttachmentUploadStore.subscribe(changed),
          useRightPanelStore.subscribe(changed),
          subscribeClientSettingsHydration(changed),
          subscribeLiveClientWork(changed),
          router.subscribe("onResolved", changed),
        ];
        return () => disposers.forEach((dispose) => dispose());
      },
      onInvalidated: requestAttempt,
    });
  async function attempt(): Promise<void> {
    const version = state?.candidateVersion;
    if (disposed || attempting || state?.phase !== "ready" || !version) return;
    attempting = true;
    let requestedActivation = false;
    try {
      guard ??= createGuard();
      const currentGuard = guard;
      const token = await currentGuard.prepare();
      if (!token) {
        const safety = currentGuard.read();
        const reason = safety.eligible ? "checkpoint-not-acknowledged" : safety.reason;
        if (document.documentElement.dataset.liveClientDeferred !== reason) {
          document.documentElement.dataset.liveClientDeferred = reason;
        }
      } else {
        delete document.documentElement.dataset.liveClientDeferred;
      }
      if (!token || disposed || state?.candidateVersion !== version) return;
      requestedActivation = true;
      const accepted = await bridge!.activate(version);
      if (!accepted) return;
      if (
        disposed ||
        state?.candidateVersion !== version ||
        !currentGuard.activate(token, () => navigateToLiveClientTrial(version))
      ) {
        await bridge!.fail(version, false);
      }
    } catch {
      if (requestedActivation) await bridge!.fail(version, false).catch(() => undefined);
    } finally {
      attempting = false;
    }
  }
  const receive = (next: DesktopLiveClientUpdateState) => {
    if (disposed) return;
    state = next;
    if (!initializing) requestAttempt();
  };
  unsubscribeBridge = bridge.onState(receive);
  void bridge
    .getState()
    .then((initial) => {
      if (disposed) return;
      initializing = false;
      const latest = state ?? initial;
      if (latest.phase === "disabled") {
        unsubscribeBridge();
        unsubscribeBridge = () => {};
        return;
      }
      receive(latest);
    })
    .catch(() => {
      unsubscribeBridge();
      unsubscribeBridge = () => {};
    });
  return () => {
    disposed = true;
    unsubscribeBridge();
    guard?.dispose();
  };
}
