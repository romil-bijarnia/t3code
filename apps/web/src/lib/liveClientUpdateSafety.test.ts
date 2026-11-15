import { describe, expect, it, vi } from "vite-plus/test";

import {
  createLiveClientUpdateSafety,
  evaluateLiveClientUpdateSafety,
  type LiveClientUpdateSafetyFacts,
} from "./liveClientUpdateSafety";

function facts(): LiveClientUpdateSafetyFacts {
  return {
    desktop: true,
    supportedRoute: true,
    hydrated: true,
    persistenceReady: true,
    hasComposerContent: false,
    hasQuestionDraft: false,
    hasAttachmentPreparation: false,
    hasRendererMutation: false,
    hasRecording: false,
    hasUnsafePanel: false,
  };
}

describe("live client update safety", () => {
  it("defers while any pointer is held until its matching release or cancellation", async () => {
    const events = new EventTarget();
    const guard = createLiveClientUpdateSafety({
      readFacts: facts,
      documentHasRisk: () => false,
      flush: () => {},
      subscribe: () => () => {},
      events,
    });
    const pointer = (type: string, pointerId: number) =>
      Object.assign(new Event(type), { pointerId });
    try {
      events.dispatchEvent(pointer("pointerdown", 1));
      events.dispatchEvent(pointer("pointerdown", 2));
      expect(await guard.prepare()).toBeNull();
      events.dispatchEvent(pointer("pointerup", 1));
      expect(await guard.prepare()).toBeNull();
      events.dispatchEvent(pointer("pointercancel", 2));
      expect(await guard.prepare()).not.toBeNull();
    } finally {
      guard.dispose();
    }
  });

  it("requires explicit coverage of every renderer state boundary", () => {
    expect(evaluateLiveClientUpdateSafety({})).toEqual({
      eligible: false,
      reason: "unknown-state",
    });
    expect(evaluateLiveClientUpdateSafety(null).eligible).toBe(false);
    expect(evaluateLiveClientUpdateSafety(undefined).eligible).toBe(false);
    for (const key of Object.keys(facts()) as Array<keyof LiveClientUpdateSafetyFacts>) {
      const incomplete: Partial<LiveClientUpdateSafetyFacts> = facts();
      delete incomplete[key];
      expect(evaluateLiveClientUpdateSafety(incomplete).eligible).toBe(false);
    }
  });

  it.each([
    ["desktop", false],
    ["supportedRoute", false],
    ["hydrated", false],
    ["persistenceReady", false],
    ["hasComposerContent", true],
    ["hasQuestionDraft", true],
    ["hasAttachmentPreparation", true],
    ["hasRendererMutation", true],
    ["hasRecording", true],
    ["hasUnsafePanel", true],
  ] as const)("defers when %s is %s", (key, value) => {
    expect(evaluateLiveClientUpdateSafety({ ...facts(), [key]: value }).eligible).toBe(false);
  });

  it("does not make backend agent or terminal activity a renderer veto", () => {
    const state = { ...facts(), activeAgents: 3, activeTerminalCommands: 2 };
    expect(evaluateLiveClientUpdateSafety(state)).toEqual({ eligible: true });
  });

  it("rechecks after persistence and consumes each preparation exactly once", async () => {
    let state = facts();
    let invalidate = () => {};
    const events = new EventTarget();
    const flush = vi.fn();
    const unsubscribe = vi.fn();
    const guard = createLiveClientUpdateSafety({
      readFacts: () => state,
      documentHasRisk: () => false,
      flush,
      events,
      subscribe: (listener) => {
        invalidate = listener;
        return unsubscribe;
      },
    });
    const navigate = vi.fn();
    const beforeTyping = await guard.prepare();
    expect(beforeTyping).not.toBeNull();
    state = { ...state, hasComposerContent: true };
    invalidate();
    expect(guard.activate(beforeTyping!, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(await guard.prepare()).toBeNull();
    state = facts();
    invalidate();
    const prepared = await guard.prepare();
    const duplicate = await guard.prepare();
    expect(guard.activate(prepared!, navigate)).toBe(true);
    expect(guard.activate(prepared!, navigate)).toBe(false);
    expect(guard.activate(duplicate!, navigate)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
    guard.dispose();
    guard.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(await guard.prepare()).toBeNull();
  });

  it("rejects interaction during flush and a later input before navigation", async () => {
    const events = new EventTarget();
    let resolveFlush = () => {};
    let flush = () => new Promise<void>((resolve) => (resolveFlush = resolve));
    const guard = createLiveClientUpdateSafety({
      readFacts: facts,
      documentHasRisk: () => false,
      flush: () => flush(),
      subscribe: () => () => {},
      events,
    });
    const pending = guard.prepare();
    expect(await guard.prepare()).toBeNull();
    events.dispatchEvent(new Event("input"));
    resolveFlush();
    expect(await pending).toBeNull();
    flush = () => Promise.resolve();
    const token = await guard.prepare();
    events.dispatchEvent(new Event("pointerdown"));
    expect(guard.activate(token!, () => expect.unreachable())).toBe(false);
    guard.dispose();
  });

  it("defers during IME composition and isolates failed change notifications", async () => {
    const events = new EventTarget();
    const guard = createLiveClientUpdateSafety({
      readFacts: facts,
      documentHasRisk: () => false,
      flush: () => {},
      subscribe: () => () => {},
      events,
    });
    events.dispatchEvent(new Event("compositionstart"));
    expect(await guard.prepare()).toBeNull();
    events.dispatchEvent(new Event("compositionend"));
    expect(await guard.prepare()).not.toBeNull();
    guard.dispose();
    const broken = createLiveClientUpdateSafety({
      readFacts: facts,
      documentHasRisk: () => false,
      flush: () => {},
      subscribe: () => () => {},
      events,
      onInvalidated: () => {
        throw new Error("unavailable activation host");
      },
    });
    expect(() => events.dispatchEvent(new Event("input"))).not.toThrow();
    expect(await broken.prepare()).toBeNull();
    broken.dispose();
  });

  it("fails closed on storage, document and state-reader failures", async () => {
    let documentRisk = true;
    let stateError = false;
    const guard = createLiveClientUpdateSafety({
      readFacts: () => {
        if (stateError) throw new Error("unavailable state");
        return facts();
      },
      documentHasRisk: () => documentRisk,
      flush: () => Promise.reject(new Error("storage full")),
      subscribe: () => () => {},
      events: new EventTarget(),
    });
    expect(await guard.prepare()).toBeNull();
    documentRisk = false;
    expect(await guard.prepare()).toBeNull();
    stateError = true;
    expect(guard.read()).toEqual({ eligible: false, reason: "unknown-state" });
    expect(guard.activate({ revision: 0 }, () => expect.unreachable())).toBe(false);
    guard.dispose();
  });
});
