// @effect-diagnostics nodeBuiltinImport:off - Registry fixtures use native paths and real content digests.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createLiveClientAssets } from "./liveClientAssets.ts";
import type { LiveClientManifest } from "./liveClientManifest.ts";

function bundle(version: string, files: Record<string, string>) {
  const manifest: LiveClientManifest = {
    format: 1,
    version,
    channel: "nightly",
    runtimeId: "a".repeat(64),
    files: Object.entries({ "index.html": version, ...files }).map(([filePath, sha256]) => ({
      path: filePath,
      sha256: NodeCrypto.createHash("sha256").update(sha256).digest("hex"),
      size: 1,
    })),
  };
  return { root: NodePath.resolve(`bundles/${version}`), manifest };
}

function readyToken(result: ReturnType<ReturnType<typeof createLiveClientAssets>["stage"]>) {
  if (result.status !== "ready") throw new Error(`Unexpected rejection: ${result.reason}`);
  return result.token;
}

describe("live client asset generations", () => {
  it("keeps old lazy chunks available through activation and rollback", () => {
    const first = bundle("1", { "assets/app-a.js": "a", "assets/lazy-a.js": "b" });
    const second = bundle("2", { "assets/app-b.js": "c", "assets/lazy-b.js": "d" });
    const assets = createLiveClientAssets(first);
    const token = readyToken(assets.stage(second));

    expect(assets.resolve("index.html")).toBe(NodePath.join(first.root, "index.html"));
    expect(assets.resolve("assets/app-b.js")).toBeUndefined();
    expect(assets.activate(token)).toBe(true);
    expect(assets.activate(token)).toBe(false);
    expect(assets.resolve("index.html")).toBe(NodePath.join(second.root, "index.html"));
    expect(assets.resolve("assets/lazy-a.js")).toBe(NodePath.join(first.root, "assets/lazy-a.js"));
    expect(assets.resolve("assets/lazy-b.js")).toBe(NodePath.join(second.root, "assets/lazy-b.js"));

    expect(assets.rollback()).toBe(true);
    expect(assets.resolve("index.html")).toBe(NodePath.join(first.root, "index.html"));
    expect(assets.resolve("assets/lazy-a.js")).toBe(NodePath.join(first.root, "assets/lazy-a.js"));
    expect(assets.resolve("assets/lazy-b.js")).toBe(NodePath.join(second.root, "assets/lazy-b.js"));
    expect(assets.rollback()).toBe(false);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const prepared = assets.stage({ ...second, root: second.root + NodePath.sep + "." });
      expect(assets.activate(readyToken(prepared))).toBe(true);
      expect(assets.resolve("index.html")).toBe(NodePath.join(second.root, "index.html"));
      expect(assets.rollback()).toBe(true);
      expect(assets.resolve("assets/lazy-a.js")).toBe(
        NodePath.join(first.root, "assets/lazy-a.js"),
      );
      expect(assets.resolve("assets/lazy-b.js")).toBe(
        NodePath.join(second.root, "assets/lazy-b.js"),
      );
    }
  });

  it("rejects unhashed path collisions without changing the active or staged bundle", () => {
    const first = bundle("1", { "assets/app.js": "a" });
    const assets = createLiveClientAssets(first);
    const second = bundle("2", { "assets/app-b.js": "b", "assets/app.js": "a" });
    const token = readyToken(assets.stage(second));
    expect(assets.stage(bundle("3", { "assets/app.js": "changed" }))).toEqual({
      status: "deferred",
      reason: "asset-collision",
      path: "assets/app.js",
    });
    expect(assets.resolve("index.html")).toBe(NodePath.join(first.root, "index.html"));
    expect(assets.activate(token)).toBe(true);
    expect(assets.resolve("assets/app.js")).toBe(NodePath.join(first.root, "assets/app.js"));
  });

  it("snapshots staged metadata and invalidates superseded tokens", () => {
    const assets = createLiveClientAssets(bundle("1", {}));
    const second = bundle("2", { "assets/b.js": "b" });
    const stale = readyToken(assets.stage(second));
    const third = bundle("3", { "assets/c.js": "c" });
    const sourceFiles = [...third.manifest.files];
    third.manifest = { ...third.manifest, files: sourceFiles };
    const token = readyToken(assets.stage(third));
    sourceFiles.length = 0;
    expect(assets.activate(stale)).toBe(false);
    expect(assets.activate(token)).toBe(true);
    expect(assets.resolve("assets/c.js")).toBe(NodePath.join(third.root, "assets/c.js"));
  });

  it("defers rather than evicting resources when the generation limit is reached", () => {
    const first = bundle("1", { "assets/first.js": "first" });
    const assets = createLiveClientAssets(first);
    for (let version = 2; version <= 8; version += 1) {
      expect(assets.activate(readyToken(assets.stage(bundle(String(version), {}))))).toBe(true);
    }
    expect(assets.rollback()).toBe(true);
    expect(assets.resolve("index.html")).toBe(NodePath.join(bundle("7", {}).root, "index.html"));
    expect(assets.stage(bundle("9", {}))).toEqual({
      status: "deferred",
      reason: "generation-limit",
    });
    expect(assets.activate(readyToken(assets.stage(bundle("8", {}))))).toBe(true);
    expect(assets.stage(bundle("9", {}))).toEqual({
      status: "deferred",
      reason: "generation-limit",
    });
    expect(assets.resolve("assets/first.js")).toBe(NodePath.join(first.root, "assets/first.js"));
  });

  it.each(["../secret", "/absolute", "assets/../secret", "assets//file", "assets\\file", "a\0b"])(
    "rejects invalid manifest paths and never resolves %j",
    (invalid) => {
      const first = bundle("1", {});
      const assets = createLiveClientAssets(first);
      expect(assets.stage(bundle("2", { [invalid]: "b" }))).toEqual({
        status: "deferred",
        reason: "invalid-path",
        path: invalid,
      });
      expect(assets.resolve(invalid)).toBeUndefined();
      expect(assets.resolve("missing.js")).toBeUndefined();
      expect(assets.resolve("index.html")).toBe(NodePath.join(first.root, "index.html"));
    },
  );
});
