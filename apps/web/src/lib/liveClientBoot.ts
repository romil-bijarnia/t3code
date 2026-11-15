import { isUnfocusedEmptyComposer } from "./liveClientUpdateSafety";

let pendingAcknowledgement: Promise<boolean> | null = null;
let cancelPendingFocusRestore: (() => void) | null = null;

function restoreEmptyComposerFocus(): void {
  cancelPendingFocusRestore?.();
  const restore = () => {
    if (!document.hasFocus()) return;
    cancelPendingFocusRestore?.();
    cancelPendingFocusRestore = null;
    const editor = document.querySelector<HTMLElement>(
      '[data-testid="composer-editor"][contenteditable="true"]',
    );
    const active = document.activeElement;
    if (
      editor?.textContent === "" &&
      (active === document.body ||
        active === document.documentElement ||
        active === document.getElementById("root") ||
        active === editor)
    ) {
      editor.focus({ preventScroll: true });
    }
  };
  if (document.hasFocus()) restore();
  else {
    window.addEventListener("focus", restore);
    cancelPendingFocusRestore = () => window.removeEventListener("focus", restore);
  }
}

async function withinTrialDeadline<T>(request: Promise<T>): Promise<{ value: T } | null> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.then(
        (value) => ({ value }),
        () => null,
      ),
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

export function navigateToLiveClientTrial(
  version: string,
  navigate: (destination: URL) => void = (destination) => window.location.replace(destination),
): void {
  const destination = new URL(window.location.href);
  destination.searchParams.set("__t3_live_client_trial", version);
  const restoreComposer = isUnfocusedEmptyComposer(document);
  destination.searchParams.delete("__t3_live_client_focus");
  if (restoreComposer) destination.searchParams.set("__t3_live_client_focus", "composer");
  const previousFocus = document.activeElement;
  const previousInert = document.body.inert;
  const previousTrial = document.documentElement.dataset.liveClientTrial;
  document.body.inert = true;
  document.documentElement.dataset.liveClientTrial = version;
  try {
    navigate(destination);
  } catch (error) {
    document.body.inert = previousInert;
    if (previousTrial === undefined) delete document.documentElement.dataset.liveClientTrial;
    else document.documentElement.dataset.liveClientTrial = previousTrial;
    if (restoreComposer) restoreEmptyComposerFocus();
    else if (document.hasFocus() && previousFocus instanceof HTMLElement)
      previousFocus.focus({ preventScroll: true });
    throw error;
  }
}

export function acknowledgeLiveClientBoot(): Promise<boolean> {
  const version = document.querySelector<HTMLMetaElement>(
    'meta[name="t3-live-client-version"]',
  )?.content;
  const url = new URL(window.location.href);
  const root = document.getElementById("root");
  const bridge = window.desktopBridge?.liveClientUpdates;
  if (!version || !bridge || !root || url.searchParams.get("__t3_live_client_trial") !== version) {
    return Promise.resolve(false);
  }
  if (pendingAcknowledgement) return pendingAcknowledgement;
  pendingAcknowledgement = (async () => {
    let confirmApplied = (_value: true) => {};
    const observedProof = new Promise<true>((resolve) => {
      confirmApplied = resolve;
    });
    const unsubscribe = bridge.onState((state) => {
      if (state.phase === "applied" && state.currentVersion === version) confirmApplied(true);
    });
    try {
      const acknowledgement = await withinTrialDeadline(
        Promise.race([Promise.resolve().then(() => bridge.acknowledge(version)), observedProof]),
      );
      let accepted = acknowledgement?.value === true;
      if (!accepted) {
        const reconciliation = Promise.resolve()
          .then(() => bridge.getState())
          .then((state) => state.phase === "applied" && state.currentVersion === version);
        accepted =
          (await withinTrialDeadline(Promise.race([reconciliation, observedProof])))?.value ===
          true;
      }
      const current = new URL(window.location.href);
      if (current.searchParams.get("__t3_live_client_trial") !== version) return false;
      if (!accepted) {
        void Promise.resolve()
          .then(() => bridge.fail(version, true))
          .catch(() => undefined);
        return false;
      }
      current.searchParams.delete("__t3_live_client_trial");
      const restoreComposer = current.searchParams.get("__t3_live_client_focus") === "composer";
      current.searchParams.delete("__t3_live_client_focus");
      window.history.replaceState(window.history.state, "", current);
      delete document.documentElement.dataset.liveClientTrial;
      document.body.inert = false;
      root.inert = false;
      if (restoreComposer) restoreEmptyComposerFocus();
      return true;
    } finally {
      unsubscribe();
    }
  })().finally(() => {
    pendingAcknowledgement = null;
  });
  return pendingAcknowledgement;
}
