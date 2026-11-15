export interface LiveClientUpdateSafetyFacts {
  desktop: boolean;
  supportedRoute: boolean;
  hydrated: boolean;
  persistenceReady: boolean;
  hasComposerContent: boolean;
  hasQuestionDraft: boolean;
  hasAttachmentPreparation: boolean;
  hasRendererMutation: boolean;
  hasRecording: boolean;
  hasUnsafePanel: boolean;
}

export type LiveClientUpdateDeferral =
  | "unknown-state"
  | "unsupported-surface"
  | "unsupported-route"
  | "not-ready"
  | "unsaved-state"
  | "renderer-busy"
  | "interactive-surface";

export type LiveClientUpdateSafety =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: LiveClientUpdateDeferral };

const documentBlockers = new Set<() => boolean>();
const DOCUMENT_SAFETY_CHANGE = "t3-live-client-safety-change";

export function registerLiveClientDocumentBlocker(blocked: () => boolean): () => void {
  documentBlockers.add(blocked);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DOCUMENT_SAFETY_CHANGE));
  return () => {
    documentBlockers.delete(blocked);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(DOCUMENT_SAFETY_CHANGE));
  };
}

const factNames = [
  "desktop",
  "supportedRoute",
  "hydrated",
  "persistenceReady",
  "hasComposerContent",
  "hasQuestionDraft",
  "hasAttachmentPreparation",
  "hasRendererMutation",
  "hasRecording",
  "hasUnsafePanel",
] as const satisfies ReadonlyArray<keyof LiveClientUpdateSafetyFacts>;

export function evaluateLiveClientUpdateSafety(
  facts: Partial<LiveClientUpdateSafetyFacts> | null | undefined,
): LiveClientUpdateSafety {
  if (facts === null || facts === undefined) {
    return { eligible: false, reason: "unknown-state" };
  }
  if (factNames.some((key) => typeof facts[key] !== "boolean")) {
    return { eligible: false, reason: "unknown-state" };
  }
  if (!facts.desktop) return { eligible: false, reason: "unsupported-surface" };
  if (!facts.supportedRoute) return { eligible: false, reason: "unsupported-route" };
  if (!facts.hydrated || !facts.persistenceReady) {
    return { eligible: false, reason: "not-ready" };
  }
  if (facts.hasComposerContent || facts.hasQuestionDraft) {
    return { eligible: false, reason: "unsaved-state" };
  }
  if (facts.hasAttachmentPreparation || facts.hasRendererMutation || facts.hasRecording) {
    return { eligible: false, reason: "renderer-busy" };
  }
  if (facts.hasUnsafePanel) return { eligible: false, reason: "interactive-surface" };
  return { eligible: true };
}

export function isUnfocusedEmptyComposer(document: Document): boolean {
  const focused = document.activeElement;
  return (
    !document.hasFocus() &&
    focused?.matches(
      '[data-testid="composer-editor"][contenteditable="true"]:not(input):not(textarea):not(select)',
    ) === true &&
    focused.textContent === ""
  );
}

/** DOM checks supplement the store boundary; they cannot certify unregistered application state. */
export function hasLiveClientDocumentRisk(document: Document): boolean {
  if (document.readyState !== "complete") return true;
  if (document.querySelector("[data-live-client-blocker]")) return true;
  for (const blocked of documentBlockers) if (blocked()) return true;
  for (const viewport of document.querySelectorAll<HTMLElement>("[data-live-client-timeline]")) {
    if (
      viewport.dataset.liveClientFollowingEnd !== "true" ||
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1
    )
      return true;
  }
  for (const media of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
    if (!media.ended && (!media.paused || media.currentTime > 0)) return true;
  }
  if (document.getSelection()?.toString()) return true;
  if (
    document.querySelector(
      'dialog[open], [role="dialog"]:not([hidden]):not([aria-hidden="true"]):not([data-state="closed"]), [role="alertdialog"], [role="menu"], .monaco-editor, .cm-editor, audio[data-recording="true"], video[data-recording="true"]',
    )
  ) {
    return true;
  }
  const focused = document.activeElement;
  if (
    focused &&
    (focused.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])') ||
      focused.closest('[contenteditable]:not([contenteditable="false"])')) &&
    !isUnfocusedEmptyComposer(document)
  ) {
    return true;
  }
  for (const input of document.querySelectorAll("input")) {
    if ((input.files?.length ?? 0) > 0) return true;
    if (input.getAttribute("aria-hidden") === "true" && input.tabIndex < 0) continue;
    if (input.type === "hidden" || input.type === "button" || input.type === "submit") continue;
    if (input.type === "checkbox" || input.type === "radio" || input.type === "range") continue;
    if (input.value.length > 0) return true;
  }
  for (const textarea of document.querySelectorAll("textarea")) {
    if (textarea.value.length > 0) return true;
  }
  for (const editable of document.querySelectorAll(
    '[contenteditable]:not([contenteditable="false"])',
  )) {
    if ((editable.textContent ?? "").length > 0) return true;
  }
  return false;
}

export interface PreparedLiveClientUpdate {
  readonly revision: number;
}

export function createLiveClientUpdateSafety(input: {
  readonly readFacts: () => Partial<LiveClientUpdateSafetyFacts>;
  readonly documentHasRisk: () => boolean;
  readonly flush: () => void | Promise<void>;
  readonly subscribe: (invalidate: () => void) => () => void;
  readonly events: EventTarget;
  readonly onInvalidated?: () => void;
}) {
  let revision = 0;
  let disposed = false;
  let preparing = false;
  let composing = false;
  const heldPointers = new Set<number>();
  let notificationFailed = false;
  const prepared = new WeakSet<PreparedLiveClientUpdate>();
  const invalidate = () => {
    revision += 1;
    try {
      input.onInvalidated?.();
    } catch {
      notificationFailed = true;
    }
  };
  const compositionStart = () => {
    composing = true;
    invalidate();
  };
  const compositionEnd = () => {
    composing = false;
    invalidate();
  };
  const pointerDown = (event: Event) => {
    heldPointers.add((event as PointerEvent).pointerId ?? 0);
    invalidate();
  };
  const pointerReleased = (event: Event) => {
    heldPointers.delete((event as PointerEvent).pointerId ?? 0);
    invalidate();
  };
  const events = [
    DOCUMENT_SAFETY_CHANGE,
    "scroll",
    "play",
    "pause",
    "ended",
    "emptied",
    "seeked",
    "blur",
    "focus",
    "load",
    "pageshow",
    "input",
    "change",
    "keydown",
    "keyup",
    "click",
    "focusin",
    "focusout",
  ];
  const unsubscribe = input.subscribe(invalidate);
  for (const event of events) input.events.addEventListener(event, invalidate, true);
  input.events.addEventListener("compositionstart", compositionStart, true);
  input.events.addEventListener("compositionend", compositionEnd, true);
  input.events.addEventListener("pointerdown", pointerDown, true);
  input.events.addEventListener("pointerup", pointerReleased, true);
  input.events.addEventListener("pointercancel", pointerReleased, true);
  const read = (): LiveClientUpdateSafety => {
    if (disposed || notificationFailed) return { eligible: false, reason: "not-ready" };
    try {
      const safety = evaluateLiveClientUpdateSafety(input.readFacts());
      if (!safety.eligible) return safety;
      return composing || heldPointers.size > 0 || input.documentHasRisk()
        ? { eligible: false, reason: "interactive-surface" }
        : safety;
    } catch {
      return { eligible: false, reason: "unknown-state" };
    }
  };
  return {
    read,
    async prepare(): Promise<PreparedLiveClientUpdate | null> {
      if (preparing || !read().eligible) return null;
      preparing = true;
      const before = revision;
      try {
        await input.flush();
        if (revision !== before || !read().eligible) return null;
        const token = Object.freeze({ revision });
        prepared.add(token);
        return token;
      } catch {
        return null;
      } finally {
        preparing = false;
      }
    },
    // Recheck after awaited host IPC, then navigate in this same JavaScript task.
    activate(token: PreparedLiveClientUpdate, navigate: () => void): boolean {
      if (!prepared.delete(token) || token.revision !== revision || !read().eligible) return false;
      revision += 1;
      navigate();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const event of events) input.events.removeEventListener(event, invalidate, true);
      input.events.removeEventListener("compositionstart", compositionStart, true);
      input.events.removeEventListener("compositionend", compositionEnd, true);
      input.events.removeEventListener("pointerdown", pointerDown, true);
      input.events.removeEventListener("pointerup", pointerReleased, true);
      input.events.removeEventListener("pointercancel", pointerReleased, true);
    },
  };
}
