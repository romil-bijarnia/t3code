// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This Promise-based installer owns bounded file streams and abort/boot deadlines at the Electron boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { compareSemverVersions } from "@t3tools/shared/semver";

import { createLiveClientAssets } from "./liveClientAssets.ts";
import { verifyBundle, verifyManifest, type LiveClientManifest } from "./liveClientManifest.ts";

export type LiveClientUpdateState = {
  readonly phase: "idle" | "checking" | "ready" | "activating" | "applied" | "deferred";
  readonly currentVersion: string;
  readonly candidateVersion: string | null;
  readonly reason: string | null;
};

export interface LiveClientUpdaterOptions {
  readonly baseline: LiveClientManifest;
  readonly baselineRoot: string;
  readonly cacheRoot: string;
  readonly publicKey: string;
  readonly feedUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly onState?: (state: LiveClientUpdateState) => void;
  readonly activationTimeoutMs?: number;
  readonly onRollback?: (version: string) => void;
}

type Candidate = { manifest: LiveClientManifest; token: symbol; root: string; retained: boolean };

const MAX_MANIFEST_BYTES = 3 * 1024 * 1024;

function feedUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Live client updates require HTTPS or an explicit loopback fixture.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error("Live client download failed.");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("Live client response exceeds its declared limit.");
      parts.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, size);
}

export function createLiveClientUpdater(options: LiveClientUpdaterOptions) {
  const origin = feedUrl(options.feedUrl);
  const fetch = options.fetch ?? globalThis.fetch;
  const assets = createLiveClientAssets({ root: options.baselineRoot, manifest: options.baseline });
  let state: LiveClientUpdateState = {
    phase: "idle",
    currentVersion: options.baseline.version,
    candidateVersion: null,
    reason: null,
  };
  let pending: Candidate | null = null;
  let trial: Candidate | null = null;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let baselineVerified = false;
  const failedVersions = new Set<string>();
  const publish = (next: Partial<LiveClientUpdateState>) => {
    state = { ...state, ...next };
    options.onState?.({ ...state });
  };
  const download = (url: URL, signal: AbortSignal) =>
    fetch(url, { signal, redirect: "error", cache: "no-store", credentials: "omit" });

  const rollback = (reason: string, reload = true) => {
    if (!trial) return false;
    const candidate = trial;
    const version = candidate.manifest.version;
    clearTimeout(deadline);
    if (reload) failedVersions.add(version);
    assets.rollback();
    trial = null;
    if (!reload) {
      const staged = assets.stage({ root: candidate.root, manifest: candidate.manifest });
      if (staged.status === "ready") pending = { ...candidate, token: staged.token };
    }
    publish({
      phase: pending ? "ready" : "deferred",
      reason: reload ? reason : "renderer-state-changed",
    });
    if (reload) options.onRollback?.(version);
    return true;
  };

  const runCheck = async () => {
    if (disposed || trial) return;
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(() => abort.abort(), 120_000);
    let staging: string | null = null;
    publish({ phase: "checking", reason: null });
    try {
      const bytes = await readBounded(
        await download(new URL("manifest.json", origin), abort.signal),
        MAX_MANIFEST_BYTES,
      );
      const manifest = verifyManifest(
        JSON.parse(new TextDecoder().decode(bytes)),
        options.publicKey,
      );
      if (
        manifest.runtimeId !== options.baseline.runtimeId ||
        manifest.channel !== options.baseline.channel
      ) {
        if (pending && !pending.retained)
          await NodeFSP.rm(pending.root, { recursive: true, force: true });
        pending = null;
        publish({
          phase: "deferred",
          candidateVersion: manifest.version,
          reason: "incompatible-runtime",
        });
        return;
      }
      if (failedVersions.has(manifest.version)) {
        if (pending && !pending.retained)
          await NodeFSP.rm(pending.root, { recursive: true, force: true });
        pending = null;
        publish({
          phase: "deferred",
          candidateVersion: manifest.version,
          reason: "previous-activation-failed",
        });
        return;
      }
      if (compareSemverVersions(manifest.version, state.currentVersion) <= 0) {
        publish({ phase: pending ? "ready" : "idle", reason: null });
        return;
      }
      if (pending && compareSemverVersions(manifest.version, pending.manifest.version) <= 0) {
        publish({ phase: "ready", reason: null });
        return;
      }
      if (!baselineVerified) {
        await verifyBundle(options.baselineRoot, options.baseline);
        baselineVerified = true;
      }
      await NodeFSP.mkdir(options.cacheRoot, { recursive: true, mode: 0o700 });
      staging = await NodeFSP.mkdtemp(NodePath.join(options.cacheRoot, ".staging-"));
      let nextFile = 0;
      const root = staging;
      const workers = Array.from({ length: Math.min(4, manifest.files.length) }, async () => {
        try {
          for (;;) {
            const file = manifest.files[nextFile++];
            if (!file) break;
            const pathname = file.path.split("/").map(encodeURIComponent).join("/");
            const response = await download(new URL(`client/${pathname}`, origin), abort.signal);
            if (!response.ok || !response.body)
              throw new Error("Live client asset download failed.");
            const target = NodePath.join(root, file.path);
            await NodeFSP.mkdir(NodePath.join(target, ".."), { recursive: true, mode: 0o700 });
            const handle = await NodeFSP.open(target, "wx", 0o600);
            const reader = response.body.getReader();
            const hash = NodeCrypto.createHash("sha256");
            let size = 0;
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.byteLength;
                if (size > file.size)
                  throw new Error("Live client asset exceeds its declared size.");
                hash.update(next.value);
                await handle.writeFile(next.value);
              }
              if (size !== file.size || hash.digest("hex") !== file.sha256) {
                throw new Error("Live client asset integrity check failed.");
              }
            } catch (error) {
              await reader.cancel().catch(() => {});
              throw error;
            } finally {
              reader.releaseLock();
              await handle.close();
            }
          }
        } catch (error) {
          abort.abort();
          throw error;
        }
      });
      const results = await Promise.allSettled(workers);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      await verifyBundle(staging, manifest);
      if (
        (manifest.files.find((file) => file.path === "index.html")?.size ?? Infinity) >
        1024 * 1024
      ) {
        throw new Error("Live client entry exceeds its size limit.");
      }
      const index = await NodeFSP.readFile(NodePath.join(staging, "index.html"), "utf8");
      const markers = [
        ...index.matchAll(
          /<meta\s+name=["']t3-live-client-version["']\s+content=["']([^"']+)["'][^>]*>/gi,
        ),
      ];
      const namedMarkers =
        index.match(/<meta\b[^>]*\bname\s*=\s*["']t3-live-client-version["'][^>]*>/gi) ?? [];
      if (
        namedMarkers.length !== 1 ||
        markers.length !== 1 ||
        markers[0]?.[1] !== manifest.version
      ) {
        throw new Error("Live client entry does not identify the signed version.");
      }
      if (disposed || abort.signal.aborted) throw new Error("Live client update cancelled.");
      const published = NodePath.join(
        NodePath.dirname(staging),
        NodePath.basename(staging).replace(".staging-", "client-"),
      );
      await NodeFSP.rename(staging, published);
      staging = published;
      const candidate = assets.stage({ root: published, manifest });
      if (candidate.status !== "ready") {
        if (pending && !pending.retained)
          await NodeFSP.rm(pending.root, { recursive: true, force: true });
        pending = null;
        publish({
          phase: "deferred",
          candidateVersion: manifest.version,
          reason: candidate.reason,
        });
        return;
      }
      if (pending && !pending.retained)
        await NodeFSP.rm(pending.root, { recursive: true, force: true });
      pending = { manifest, token: candidate.token, root: published, retained: false };
      staging = null;
      publish({ phase: "ready", candidateVersion: manifest.version, reason: null });
    } catch {
      publish({ phase: pending ? "ready" : "deferred", reason: "validation-or-download-failed" });
    } finally {
      clearTimeout(timeout);
      if (controller === abort) controller = null;
      if (staging) await NodeFSP.rm(staging, { recursive: true, force: true });
    }
  };

  return {
    getState: () => ({ ...state }),
    resolveAsset: assets.resolve,
    check: () => {
      if (inFlight) return inFlight;
      inFlight = runCheck().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    activate: (version: string) => {
      if (disposed || inFlight || trial || !pending || version !== pending.manifest.version)
        return false;
      if (!assets.activate(pending.token)) return false;
      pending.retained = true;
      trial = pending;
      pending = null;
      publish({ phase: "activating", reason: null });
      deadline = setTimeout(
        () => rollback("boot-not-acknowledged"),
        options.activationTimeoutMs ?? 30_000,
      );
      return true;
    },
    acknowledge: (version: string) => {
      if (!trial || version !== trial.manifest.version) return false;
      clearTimeout(deadline);
      trial = null;
      publish({ phase: "applied", currentVersion: version, candidateVersion: null, reason: null });
      return true;
    },
    failActivation: (version: string, reload = true) =>
      trial?.manifest.version === version && rollback("client-startup-failed", reload),
    dispose: async () => {
      disposed = true;
      controller?.abort();
      clearTimeout(deadline);
      await inFlight;
      if (pending && !pending.retained)
        await NodeFSP.rm(pending.root, { recursive: true, force: true });
      pending = null;
    },
  };
}
