// @effect-diagnostics nodeBuiltinImport:off - Cache tests use actual private directories and symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { prepareLiveClientCache } from "./liveClientCache.ts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-live-cache-"));
  return { root, [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }) };
}

it("reclaims previous generated sessions without touching live generations or other data", async () => {
  await using f = await fixture();
  const parent = NodePath.join(f.root, "live-client-cache");
  const stale = NodePath.join(parent, "session-ABC123");
  await NodeFSP.mkdir(stale, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(stale, "index.html"), "old generated client");
  await NodeFSP.writeFile(NodePath.join(parent, "other-file"), "preserve");
  const session = await prepareLiveClientCache(f.root);
  await NodeFSP.writeFile(NodePath.join(session.root, "index.html"), "running client");
  await session.cleanup();
  expect(await NodeFSP.readdir(parent)).toEqual(
    expect.arrayContaining(["other-file", NodePath.basename(session.root)]),
  );
  expect(await NodeFSP.stat(stale).catch(() => null)).toBeNull();
  expect(await NodeFSP.readFile(NodePath.join(parent, "other-file"), "utf8")).toBe("preserve");
  expect(await NodeFSP.readFile(NodePath.join(session.root, "index.html"), "utf8")).toBe(
    "running client",
  );
});

it("refuses a redirected cache root instead of deleting data through a symlink", async () => {
  await using f = await fixture();
  const elsewhere = NodePath.join(f.root, "elsewhere");
  await NodeFSP.mkdir(elsewhere);
  await NodeFSP.writeFile(NodePath.join(elsewhere, "keep"), "preserve");
  await NodeFSP.symlink(elsewhere, NodePath.join(f.root, "live-client-cache"), "junction");
  await expect(prepareLiveClientCache(f.root)).rejects.toThrow("private directory");
  expect(await NodeFSP.readFile(NodePath.join(elsewhere, "keep"), "utf8")).toBe("preserve");
});
