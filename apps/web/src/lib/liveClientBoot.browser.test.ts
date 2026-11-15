import { describe, expect, it, vi } from "vite-plus/test";
import { fakeTimers } from "../../test/render";

import { acknowledgeLiveClientBoot, navigateToLiveClientTrial } from "./liveClientBoot";

function fixture() {
  const originalUrl = window.location.href;
  const originalState = window.history.state;
  const originalBridge = window.desktopBridge;
  const originalBodyInert = document.body.inert;
  document.body.inert = true;
  const existingRoot = document.getElementById("root");
  const root = existingRoot ?? document.createElement("div");
  const originalInert = root.inert;
  root.id = "root";
  root.inert = true;
  if (!existingRoot) document.body.append(root);
  const existingMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="t3-live-client-version"]',
  );
  const meta = existingMeta ?? document.createElement("meta");
  const originalMetaContent = meta.content;
  meta.name = "t3-live-client-version";
  meta.content = "1.2.3";
  if (!existingMeta) document.head.append(meta);
  const url = new URL(originalUrl);
  url.searchParams.set("__t3_live_client_trial", meta.content);
  url.hash = "/environment/thread";
  window.history.replaceState(originalState, "", url);
  document.documentElement.dataset.liveClientTrial = meta.content;
  const acknowledge = vi.fn(async (_version: string) => true);
  const getState = vi.fn(async () => ({ phase: "activating", currentVersion: "1.2.2" }));
  const fail = vi.fn(async (_version: string, _reload: boolean) => true);
  let notify = (_state: { phase: string; currentVersion: string }) => {};
  const unsubscribe = vi.fn(() => {
    notify = () => {};
  });
  const onState = (listener: typeof notify) => {
    notify = listener;
    return unsubscribe;
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { liveClientUpdates: { acknowledge, getState, fail, onState } },
  });
  return {
    root,
    meta,
    acknowledge,
    getState,
    fail,
    unsubscribe,
    publish: (state: { phase: string; currentVersion: string }) => notify(state),
    [Symbol.dispose]() {
      document.body.inert = originalBodyInert;
      if (existingRoot) root.inert = originalInert;
      else root.remove();
      if (existingMeta) meta.content = originalMetaContent;
      else meta.remove();
      delete document.documentElement.dataset.liveClientTrial;
      window.history.replaceState(originalState, "", originalUrl);
      Object.defineProperty(window, "desktopBridge", { configurable: true, value: originalBridge });
    },
  };
}

describe("live client trial acknowledgement", () => {
  it.each(["another editor", "a new composer draft"] as const)(
    "does not overwrite %s when restoring focus",
    async (intent) => {
      using screen = fixture();
      using focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.dataset.testid = "composer-editor";
      const other = document.createElement("input");
      screen.root.append(editor, other);
      const destination = new URL(window.location.href);
      destination.searchParams.set("__t3_live_client_focus", "composer");
      window.history.replaceState(null, "", destination);
      expect(await acknowledgeLiveClientBoot()).toBe(true);
      if (intent === "another editor") other.focus();
      else editor.textContent = "new text after the update";
      const beforeFocus = document.activeElement;
      focused.mockReturnValue(true);
      window.dispatchEvent(new FocusEvent("focus"));
      expect(document.activeElement).toBe(beforeFocus);
      expect(editor.textContent).toBe(
        intent === "another editor" ? "" : "new text after the update",
      );
      editor.remove();
      other.remove();
    },
  );

  it("restores background composer focus only after the window is actually focused", async () => {
    using screen = fixture();
    using focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    using nativeFocus = vi.spyOn(window, "focus");
    document.body.inert = false;
    screen.root.inert = false;
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.dataset.testid = "composer-editor";
    screen.root.append(editor);
    editor.focus();
    navigateToLiveClientTrial("1.2.3", (destination) => {
      expect(destination.searchParams.get("__t3_live_client_focus")).toBe("composer");
      window.history.replaceState(window.history.state, "", destination);
    });
    editor.blur();
    expect(await acknowledgeLiveClientBoot()).toBe(true);
    expect(new URL(window.location.href).searchParams.has("__t3_live_client_focus")).toBe(false);
    window.dispatchEvent(new FocusEvent("focus"));
    expect(document.activeElement).not.toBe(editor);
    focused.mockReturnValue(true);
    window.dispatchEvent(new FocusEvent("focus"));
    expect(document.activeElement).toBe(editor);
    expect(nativeFocus).not.toHaveBeenCalled();
    editor.remove();
  });

  it("keeps rejected trial focus intent inert and never restores it without host proof", async () => {
    using screen = fixture();
    using focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.dataset.testid = "composer-editor";
    screen.root.append(editor);
    const target = new URL(window.location.href);
    target.searchParams.set("__t3_live_client_focus", "composer");
    window.history.replaceState(null, "", target);
    screen.acknowledge.mockResolvedValue(false);
    expect(await acknowledgeLiveClientBoot()).toBe(false);
    focused.mockReturnValue(true);
    window.dispatchEvent(new FocusEvent("focus"));
    expect(document.activeElement).not.toBe(editor);
    expect(document.body.inert).toBe(true);
    expect(new URL(window.location.href).searchParams.get("__t3_live_client_focus")).toBe(
      "composer",
    );
    editor.remove();
  });

  it("preserves background focus intent when a navigation attempt throws", () => {
    using screen = fixture();
    using focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    document.body.inert = false;
    screen.root.inert = false;
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.dataset.testid = "composer-editor";
    screen.root.append(editor);
    editor.focus();
    const original = window.location.href;
    expect(() =>
      navigateToLiveClientTrial("1.2.4", () => {
        throw new Error("blocked navigation");
      }),
    ).toThrow("blocked navigation");
    expect(document.body.inert).toBe(false);
    expect(window.location.href).toBe(original);
    editor.blur();
    focused.mockReturnValue(true);
    window.dispatchEvent(new FocusEvent("focus"));
    expect(document.activeElement).toBe(editor);
    editor.remove();
  });

  it("blocks portal and root input before navigation starts and restores failed navigation", () => {
    using screen = fixture();
    document.body.inert = false;
    delete document.documentElement.dataset.liveClientTrial;
    const before = window.location.href;
    expect(() =>
      navigateToLiveClientTrial("1.2.4", (destination) => {
        expect(document.body.inert).toBe(true);
        expect(document.documentElement.dataset.liveClientTrial).toBe("1.2.4");
        expect(destination.origin).toBe(window.location.origin);
        expect(destination.hash).toBe(window.location.hash);
        expect(destination.searchParams.get("__t3_live_client_trial")).toBe("1.2.4");
        throw new Error("navigation failed");
      }),
    ).toThrow("navigation failed");
    expect(document.body.inert).toBe(false);
    expect(document.documentElement.dataset.liveClientTrial).toBeUndefined();
    expect(window.location.href).toBe(before);
    expect(screen.acknowledge).not.toHaveBeenCalled();
  });

  it("only unlocks the trial after host acknowledgement, retaining the thread URL", async () => {
    using screen = fixture();
    let accept = (_value: boolean) => {};
    screen.acknowledge.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const acknowledgement = acknowledgeLiveClientBoot();
    expect(acknowledgeLiveClientBoot()).toBe(acknowledgement);
    await Promise.resolve();
    expect(screen.acknowledge).toHaveBeenCalledOnce();
    expect(document.body.inert).toBe(true);
    expect(screen.root.inert).toBe(true);
    expect(new URL(window.location.href).searchParams.has("__t3_live_client_trial")).toBe(true);
    accept(true);
    expect(await acknowledgement).toBe(true);
    expect(screen.acknowledge).toHaveBeenCalledExactlyOnceWith("1.2.3");
    expect(screen.root.inert).toBe(false);
    expect(document.body.inert).toBe(false);
    expect(document.documentElement.dataset.liveClientTrial).toBeUndefined();
    expect(new URL(window.location.href).searchParams.has("__t3_live_client_trial")).toBe(false);
    expect(window.location.hash).toBe("#/environment/thread");
  });

  it("reconciles a lost acknowledgement reply but leaves an unapplied trial inert", async () => {
    using screen = fixture();
    screen.acknowledge.mockRejectedValue(new Error("lost reply"));
    expect(await acknowledgeLiveClientBoot()).toBe(false);
    expect(screen.root.inert).toBe(true);
    expect(document.body.inert).toBe(true);
    screen.getState.mockResolvedValue({ phase: "applied", currentVersion: "1.2.3" });
    expect(await acknowledgeLiveClientBoot()).toBe(true);
    expect(screen.root.inert).toBe(false);
    expect(document.body.inert).toBe(false);
  });

  it("never acknowledges a baseline or a mismatched signed version", async () => {
    using screen = fixture();
    screen.meta.content = "different-version";
    expect(await acknowledgeLiveClientBoot()).toBe(false);
    expect(screen.acknowledge).not.toHaveBeenCalled();
    expect(screen.root.inert).toBe(true);
    expect(document.body.inert).toBe(true);
    const baseline = new URL(window.location.href);
    baseline.searchParams.delete("__t3_live_client_trial");
    window.history.replaceState(null, "", baseline);
    screen.meta.content = "1.2.3";
    expect(await acknowledgeLiveClientBoot()).toBe(false);
    expect(screen.acknowledge).not.toHaveBeenCalled();
  });

  it("bounds hung IPC without unlocking unproven code or retaining deadline timers", async () => {
    using screen = fixture();
    using _timers = fakeTimers();
    let lateAcknowledgement = (_accepted: boolean) => {};
    screen.acknowledge.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          lateAcknowledgement = resolve;
        }),
    );
    screen.getState.mockImplementation(() => new Promise(() => {}));
    const pending = acknowledgeLiveClientBoot();
    screen.publish({ phase: "applied", currentVersion: "1.2.2" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.root.inert).toBe(true);
    expect(document.body.inert).toBe(true);
    expect(screen.getState).toHaveBeenCalledOnce();
    screen.publish({ phase: "activating", currentVersion: "1.2.3" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(false);
    expect(screen.fail).toHaveBeenCalledExactlyOnceWith("1.2.3", true);
    expect(screen.root.inert).toBe(true);
    expect(document.body.inert).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.unsubscribe).toHaveBeenCalledOnce();
    lateAcknowledgement(true);
    await Promise.resolve();
    expect(document.body.inert).toBe(true);
    screen.acknowledge.mockResolvedValue(true);
    expect(await acknowledgeLiveClientBoot()).toBe(true);
    expect(screen.acknowledge).toHaveBeenCalledTimes(2);
    expect(screen.unsubscribe).toHaveBeenCalledTimes(2);
    expect(document.body.inert).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not unlock a newer trial with an earlier trial's late acknowledgement", async () => {
    using screen = fixture();
    let accept = (_accepted: boolean) => {};
    screen.acknowledge.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    const pending = acknowledgeLiveClientBoot();
    await Promise.resolve();
    const replacement = new URL(window.location.href);
    replacement.searchParams.set("__t3_live_client_trial", "1.2.4");
    window.history.replaceState(null, "", replacement);
    screen.meta.content = "1.2.4";
    document.documentElement.dataset.liveClientTrial = "1.2.4";
    accept(true);
    expect(await pending).toBe(false);
    expect(document.body.inert).toBe(true);
    expect(new URL(window.location.href).searchParams.get("__t3_live_client_trial")).toBe("1.2.4");
    expect(document.documentElement.dataset.liveClientTrial).toBe("1.2.4");
    expect(screen.fail).not.toHaveBeenCalled();
    expect(screen.unsubscribe).toHaveBeenCalledOnce();
  });

  it("accepts an applied event when the invocation reply is lost", async () => {
    using screen = fixture();
    screen.acknowledge.mockImplementation(() => new Promise<boolean>(() => {}));
    const pending = acknowledgeLiveClientBoot();
    screen.publish({ phase: "applied", currentVersion: "1.2.3" });
    expect(await pending).toBe(true);
    expect(document.body.inert).toBe(false);
    expect(screen.unsubscribe).toHaveBeenCalledOnce();
    expect(screen.getState).not.toHaveBeenCalled();
  });
});
