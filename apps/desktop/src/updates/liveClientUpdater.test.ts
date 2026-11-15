// @effect-diagnostics nodeBuiltinImport:off - These fixtures exercise the actual signed on-disk bundle installer.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import type { LiveClientManifest } from "./liveClientManifest.ts";
import { createLiveClientUpdater } from "./liveClientUpdater.ts";

const newClientIndex = '<meta name="t3-live-client-version" content="1.0.1">new client';

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-live-updater-"));
  const baselineRoot = NodePath.join(root, "baseline");
  const cacheRoot = NodePath.join(root, "cache");
  await NodeFSP.mkdir(baselineRoot);
  await NodeFSP.writeFile(NodePath.join(baselineRoot, "index.html"), "old client");
  const keys = NodeCrypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const file = (path: string, text: string) => ({
    path,
    size: Buffer.byteLength(text),
    sha256: NodeCrypto.createHash("sha256").update(text).digest("hex"),
  });
  const baseline: LiveClientManifest = {
    format: 1,
    version: "1.0.0",
    channel: "stable",
    runtimeId: "a".repeat(64),
    files: [file("index.html", "old client")],
  };
  let candidate: LiveClientManifest = {
    ...baseline,
    version: "1.0.1",
    files: [file("index.html", newClientIndex), file("assets/new.js", "new logic")],
  };
  let corruptSignature = false;
  let indexText = newClientIndex;
  let assetText: string | null = null;
  let gate: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | null =
    null;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("manifest.json")) {
      if (gate) {
        gate.started.resolve();
        const signal = init?.signal;
        await Promise.race([
          gate.release.promise,
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ]);
      }
      const manifest = JSON.stringify(candidate);
      const signature = NodeCrypto.sign(null, Buffer.from(manifest), keys.privateKey).toString(
        "base64",
      );
      return Response.json({ manifest, signature: corruptSignature ? "invalid" : signature });
    }
    const text = assetText ?? (url.pathname.endsWith("index.html") ? indexText : "new logic");
    return new Response(text);
  });
  const onRollback = vi.fn();
  const updater = createLiveClientUpdater({
    baseline,
    baselineRoot,
    cacheRoot,
    publicKey,
    feedUrl: "https://updates.example/live/",
    fetch,
    onRollback,
  });
  return {
    root,
    baselineRoot,
    cacheRoot,
    updater,
    fetch,
    onRollback,
    setCandidate: (patch: Partial<LiveClientManifest>) => {
      candidate = { ...candidate, ...patch };
    },
    corruptSignature: () => {
      corruptSignature = true;
    },
    corruptAsset: (text: string) => {
      assetText = text;
    },
    setIndex: (text: string) => {
      indexText = text;
      candidate = {
        ...candidate,
        files: [file("index.html", text), file("assets/new.js", "new logic")],
      };
    },
    blockManifest: () => {
      gate = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      return gate;
    },
    [Symbol.asyncDispose]: async () => {
      await updater.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

describe("live client updater", () => {
  it("stages verified code separately and only accepts a matching successful boot", async () => {
    await using f = await fixture();
    await f.updater.check();
    expect(f.updater.getState()).toMatchObject({
      phase: "ready",
      currentVersion: "1.0.0",
      candidateVersion: "1.0.1",
    });
    expect(await NodeFSP.readFile(f.updater.resolveAsset("index.html")!, "utf8")).toBe(
      "old client",
    );
    expect(f.updater.activate("stale-version")).toBe(false);
    expect(f.updater.activate("1.0.1")).toBe(true);
    expect(await NodeFSP.readFile(f.updater.resolveAsset("index.html")!, "utf8")).toBe(
      newClientIndex,
    );
    expect(f.updater.getState().currentVersion).toBe("1.0.0");
    expect(f.updater.acknowledge("1.0.0")).toBe(false);
    expect(f.updater.acknowledge("1.0.1")).toBe(true);
    expect(f.updater.getState()).toMatchObject({ phase: "applied", currentVersion: "1.0.1" });
    const downloads = f.fetch.mock.calls.length;
    await f.updater.check();
    expect(f.fetch.mock.calls.length).toBe(downloads + 1);
    expect(f.onRollback).not.toHaveBeenCalled();
    expect(await NodeFSP.readFile(NodePath.join(f.baselineRoot, "index.html"), "utf8")).toBe(
      "old client",
    );
  });

  it.each([
    "signature",
    "runtime",
    "channel",
    "downgrade",
    "corrupt",
    "truncated",
    "oversized",
  ] as const)("keeps the original code intact after %s rejection", async (failure) => {
    await using f = await fixture();
    if (failure === "signature") f.corruptSignature();
    if (failure === "runtime") f.setCandidate({ runtimeId: "b".repeat(64) });
    if (failure === "channel") f.setCandidate({ channel: "nightly", version: "1.0.1-nightly.1" });
    if (failure === "downgrade") f.setCandidate({ version: "0.9.0" });
    if (failure === "corrupt") f.corruptAsset("bad client");
    if (failure === "truncated") f.corruptAsset("x");
    if (failure === "oversized") f.corruptAsset("x".repeat(500));
    await f.updater.check();
    expect(f.updater.activate("1.0.1")).toBe(false);
    expect(f.updater.getState().currentVersion).toBe("1.0.0");
    expect(await NodeFSP.readFile(f.updater.resolveAsset("index.html")!, "utf8")).toBe(
      "old client",
    );
    expect(await NodeFSP.readdir(f.cacheRoot).catch(() => [])).toEqual([]);
    expect(f.onRollback).not.toHaveBeenCalled();
  });

  it("rolls back a failed boot and never retries that version automatically", async () => {
    await using f = await fixture();
    await f.updater.check();
    expect(f.updater.activate("1.0.1")).toBe(true);
    expect(f.updater.failActivation("1.0.1")).toBe(true);
    expect(f.updater.acknowledge("1.0.1")).toBe(false);
    expect(f.onRollback).toHaveBeenCalledTimes(1);
    expect(await NodeFSP.readFile(f.updater.resolveAsset("index.html")!, "utf8")).toBe(
      "old client",
    );
    expect(await NodeFSP.readFile(f.updater.resolveAsset("assets/new.js")!, "utf8")).toBe(
      "new logic",
    );
    const before = f.fetch.mock.calls.length;
    await f.updater.check();
    expect(f.fetch.mock.calls.length).toBe(before + 1);
    expect(f.updater.getState().reason).toBe("previous-activation-failed");
    expect(f.updater.activate("1.0.1")).toBe(false);
  });

  it("rejects a signed, intact entry that identifies the wrong client version", async () => {
    await using f = await fixture();
    f.setIndex('<meta name="t3-live-client-version" content="9.0.0">new client');
    await f.updater.check();
    expect(f.updater.getState().phase).toBe("deferred");
    expect(f.updater.activate("1.0.1")).toBe(false);
    expect(await NodeFSP.readdir(f.cacheRoot)).toEqual([]);
    expect(await NodeFSP.readFile(f.updater.resolveAsset("index.html")!, "utf8")).toBe(
      "old client",
    );
  });

  it("keeps the running version if private staging cannot be created", async () => {
    await using f = await fixture();
    await NodeFSP.writeFile(f.cacheRoot, "reserved path");
    await f.updater.check();
    expect(f.updater.getState().phase).toBe("deferred");
    expect(f.updater.activate("1.0.1")).toBe(false);
    expect(await NodeFSP.readFile(f.cacheRoot, "utf8")).toBe("reserved path");
    expect(await NodeFSP.readFile(f.updater.resolveAsset("index.html")!, "utf8")).toBe(
      "old client",
    );
  });

  it("restores the previous entry if the candidate never acknowledges boot", async () => {
    vi.useFakeTimers();
    try {
      await using f = await fixture();
      await f.updater.check();
      expect(f.updater.activate("1.0.1")).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.updater.getState()).toMatchObject({
        currentVersion: "1.0.0",
        phase: "deferred",
        reason: "boot-not-acknowledged",
      });
      expect(f.onRollback).toHaveBeenCalledWith("1.0.1");
      expect(f.updater.acknowledge("1.0.1")).toBe(false);
      expect(await NodeFSP.readFile(f.updater.resolveAsset("index.html")!, "utf8")).toBe(
        "old client",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reload the old page when its final safety check vetoes navigation", async () => {
    await using f = await fixture();
    await f.updater.check();
    expect(f.updater.activate("1.0.1")).toBe(true);
    expect(f.updater.failActivation("1.0.1", false)).toBe(true);
    expect(f.updater.getState()).toMatchObject({
      phase: "ready",
      reason: "renderer-state-changed",
    });
    expect(f.onRollback).not.toHaveBeenCalled();
    expect(await NodeFSP.readFile(f.updater.resolveAsset("index.html")!, "utf8")).toBe(
      "old client",
    );
  });

  it("serializes checks and activation, and cancels an in-flight check on disposal", async () => {
    await using f = await fixture();
    await f.updater.check();
    const gate = f.blockManifest();
    const first = f.updater.check();
    const second = f.updater.check();
    expect(first).toBe(second);
    await gate.started.promise;
    expect(f.updater.activate("1.0.1")).toBe(false);
    await f.updater.dispose();
    await first;
    expect(f.updater.activate("1.0.1")).toBe(false);
    expect(await NodeFSP.readdir(f.cacheRoot)).toEqual([]);
  });

  it("can activate the same verified bundle after an editing-race deferral", async () => {
    await using f = await fixture();
    await f.updater.check();
    expect(f.updater.activate("1.0.1")).toBe(true);
    expect(f.updater.failActivation("1.0.1", false)).toBe(true);
    expect(f.updater.activate("1.0.1")).toBe(true);
    expect(f.updater.acknowledge("1.0.1")).toBe(true);
    expect(await NodeFSP.readFile(f.updater.resolveAsset("assets/new.js")!, "utf8")).toBe(
      "new logic",
    );
  });

  it("discards a prepared older candidate when the newest signed release is incompatible", async () => {
    await using f = await fixture();
    await f.updater.check();
    f.setCandidate({ version: "1.0.2", runtimeId: "b".repeat(64) });
    await f.updater.check();
    expect(f.updater.getState()).toMatchObject({ phase: "deferred", candidateVersion: "1.0.2" });
    expect(f.updater.activate("1.0.1")).toBe(false);
    expect(await NodeFSP.readdir(f.cacheRoot)).toEqual([]);
  });
});
