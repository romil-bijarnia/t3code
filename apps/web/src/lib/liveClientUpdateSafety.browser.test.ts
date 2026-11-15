import { describe, expect, it, vi } from "vite-plus/test";

import {
  hasLiveClientDocumentRisk,
  registerLiveClientDocumentBlocker,
} from "./liveClientUpdateSafety";

function fixture() {
  const root = document.createElement("section");
  root.tabIndex = -1;
  document.body.append(root);
  root.focus();
  return {
    root,
    [Symbol.dispose]() {
      document.getSelection()?.removeAllRanges();
      root.remove();
    },
  };
}

describe("live update document boundary", () => {
  it("reads mutable disclosure state even when the parent DOM marker has not rerendered", () => {
    using screen = fixture();
    const entries = new Set<string>();
    const remove = registerLiveClientDocumentBlocker(() => entries.size > 0);
    try {
      expect(hasLiveClientDocumentRisk(document)).toBe(false);
      entries.add("expanded-tool-entry");
      expect(hasLiveClientDocumentRisk(document)).toBe(true);
      entries.clear();
      expect(hasLiveClientDocumentRisk(document)).toBe(false);
      expect(screen.root.isConnected).toBe(true);
    } finally {
      remove();
    }
  });

  it("preserves opaque embedded app state without blocking unrelated backing iframes", () => {
    using screen = fixture();
    const frame = document.createElement("iframe");
    frame.hidden = true;
    screen.root.append(frame);
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
    frame.dataset.liveClientBlocker = "embedded-app";
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
  });

  it("reads the timeline's real tail distance instead of trusting a stale follow flag", () => {
    using screen = fixture();
    const viewport = document.createElement("div");
    viewport.dataset.liveClientTimeline = "true";
    viewport.dataset.liveClientFollowingEnd = "true";
    viewport.style.cssText = "height:40px;overflow-y:auto";
    const contents = document.createElement("div");
    contents.style.height = "200px";
    viewport.append(contents);
    screen.root.append(viewport);
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
    viewport.dataset.liveClientFollowingEnd = "false";
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
  });

  it("preserves playing and paused in-progress media positions", () => {
    using screen = fixture();
    const audio = document.createElement("audio");
    screen.root.append(audio);
    using paused = vi.spyOn(audio, "paused", "get").mockReturnValue(false);
    using ended = vi.spyOn(audio, "ended", "get").mockReturnValue(false);
    using position = vi.spyOn(audio, "currentTime", "get").mockReturnValue(0);
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    paused.mockReturnValue(true);
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
    position.mockReturnValue(5);
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    ended.mockReturnValue(true);
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
  });

  it("allows only an empty background composer, not drafts or other focused editors", () => {
    using screen = fixture();
    using focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const composer = document.createElement("div");
    composer.contentEditable = "true";
    composer.dataset.testid = "composer-editor";
    screen.root.append(composer);
    composer.focus();
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
    composer.textContent = "unsent draft";
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    composer.textContent = "";
    delete composer.dataset.testid;
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    composer.dataset.testid = "composer-editor";
    focus.mockReturnValue(true);
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
  });

  it("keeps drafts, attachment bytes and focused inputs out of automatic activation", () => {
    using screen = fixture();
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
    const input = document.createElement("input");
    screen.root.append(input);
    input.focus();
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    screen.root.focus();
    input.value = "unsent question answer";
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    input.value = "";
    input.type = "file";
    const transfer = new DataTransfer();
    transfer.items.add(new File(["attachment bytes"], "note.txt"));
    input.files = transfer.files;
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    input.value = "";
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
  });

  it("ignores noninteractive combobox backing inputs without ignoring editable values", () => {
    using screen = fixture();
    const backing = document.createElement("input");
    backing.id = "base-ui-project-hidden-input";
    backing.tabIndex = -1;
    backing.setAttribute("aria-hidden", "true");
    backing.value = "all";
    backing.style.cssText = "clip-path:inset(50%);width:1px;height:1px;position:fixed";
    screen.root.append(backing);
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
    backing.focus();
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    screen.root.focus();
    backing.removeAttribute("aria-hidden");
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    backing.setAttribute("aria-hidden", "true");
    backing.tabIndex = 0;
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
  });

  it("defers open local-state dialogs and editors, but not a closed dialog", () => {
    using screen = fixture();
    const dialog = document.createElement("dialog");
    screen.root.append(dialog);
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
    dialog.open = true;
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    dialog.remove();
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    screen.root.append(editor);
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
  });

  it("preserves editable contents and text selection", () => {
    using screen = fixture();
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.textContent = "unsent prompt";
    screen.root.append(editable);
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    editable.remove();
    const text = document.createTextNode("currently selected reply");
    screen.root.append(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()?.addRange(range);
    expect(hasLiveClientDocumentRisk(document)).toBe(true);
    document.getSelection()?.removeAllRanges();
    expect(hasLiveClientDocumentRisk(document)).toBe(false);
  });
});
