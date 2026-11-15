// @effect-diagnostics nodeBuiltinImport:off - The synchronous protocol resolver needs native desktop path normalization.
import * as NodePath from "node:path";

import type { LiveClientManifest } from "./liveClientManifest.ts";

type Generation = {
  readonly root: string;
  readonly manifest: LiveClientManifest;
};

type Asset = { readonly sha256: string; readonly filePath: string };

type StageResult =
  | { readonly status: "ready"; readonly token: symbol }
  | {
      readonly status: "deferred";
      readonly reason: "asset-collision" | "generation-limit" | "invalid-path" | "missing-index";
      readonly path?: string;
    };

const MAX_GENERATIONS = 8;

function validRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !NodePath.posix.isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function snapshot(input: Generation): Generation {
  return {
    root: NodePath.resolve(input.root),
    manifest: { ...input.manifest, files: input.manifest.files.map((file) => ({ ...file })) },
  };
}

/** Registers verified bundles without repointing resources used by existing documents. */
export function createLiveClientAssets(initial: Generation) {
  const assets = new Map<string, Asset>();
  let active = snapshot(initial);
  let previous: Generation | undefined;
  let pending: { readonly token: symbol; readonly generation: Generation } | undefined;
  const retainedRoots = new Set([active.root]);

  const validate = (
    generation: Generation,
  ): Exclude<StageResult, { status: "ready" }> | undefined => {
    let hasIndex = false;
    const seen = new Set<string>();
    for (const file of generation.manifest.files) {
      if (!validRelativePath(file.path) || seen.has(file.path)) {
        return { status: "deferred", reason: "invalid-path", path: file.path };
      }
      seen.add(file.path);
      if (file.path === "index.html") {
        hasIndex = true;
        continue;
      }
      const existing = assets.get(file.path);
      if (existing && existing.sha256 !== file.sha256) {
        return { status: "deferred", reason: "asset-collision", path: file.path };
      }
    }
    return hasIndex ? undefined : { status: "deferred", reason: "missing-index" };
  };

  const append = (generation: Generation) => {
    for (const file of generation.manifest.files) {
      if (file.path !== "index.html" && !assets.has(file.path)) {
        assets.set(file.path, {
          sha256: file.sha256,
          filePath: NodePath.join(generation.root, file.path),
        });
      }
    }
  };

  if (!NodePath.isAbsolute(initial.root) || validate(active)) {
    throw new Error("The baseline live client bundle is invalid.");
  }
  append(active);

  return {
    stage(input: Generation): StageResult {
      if (!NodePath.isAbsolute(input.root)) {
        return { status: "deferred", reason: "invalid-path", path: input.root };
      }
      const candidate = snapshot(input);
      const invalid = validate(candidate);
      if (invalid) return invalid;
      if (!retainedRoots.has(candidate.root) && retainedRoots.size >= MAX_GENERATIONS) {
        return { status: "deferred", reason: "generation-limit" };
      }
      const token = Symbol(candidate.manifest.version);
      pending = { token, generation: candidate };
      return { status: "ready", token };
    },
    activate(token: symbol): boolean {
      if (pending?.token !== token) return false;
      const candidate = pending.generation;
      append(candidate);
      previous = active;
      active = candidate;
      pending = undefined;
      retainedRoots.add(candidate.root);
      return true;
    },
    rollback(): boolean {
      if (!previous) return false;
      active = previous;
      previous = undefined;
      pending = undefined;
      return true;
    },
    resolve(relativePath: string): string | undefined {
      if (!validRelativePath(relativePath)) return undefined;
      return relativePath === "index.html"
        ? NodePath.join(active.root, "index.html")
        : assets.get(relativePath)?.filePath;
    },
  };
}
