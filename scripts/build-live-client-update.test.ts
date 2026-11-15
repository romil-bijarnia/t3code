// @effect-diagnostics nodeBuiltinImport:off - Real filesystem fixtures and ephemeral signing keys exercise the offline producer.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { verifyBundle, verifyManifest } from "../apps/desktop/src/updates/liveClientManifest.ts";
import { buildLiveClientUpdate } from "./build-live-client-update.ts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-build-live-client-"));
  const keys = NodeCrypto.generateKeyPairSync("ed25519");
  const clientDir = NodePath.join(root, "source");
  const outputDir = NodePath.join(root, "release");
  await NodeFSP.mkdir(NodePath.join(clientDir, "assets"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(clientDir, ".vite"));
  await NodeFSP.writeFile(NodePath.join(clientDir, ".vite/manifest.json"), '{"build":"metadata"}');
  await NodeFSP.writeFile(
    NodePath.join(clientDir, "index.html"),
    '<meta name="t3-live-client-version" content="1.2.3"><script src="/assets/a.js"></script>',
  );
  await NodeFSP.writeFile(NodePath.join(clientDir, "assets/a.js"), "console.log('new client')");
  return {
    root,
    clientDir,
    outputDir,
    publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    input: {
      clientDir,
      outputDir,
      version: "1.2.3",
      channel: "stable" as const,
      runtimeId: "a".repeat(64),
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    },
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

it("publishes a complete signed client bundle without changing the source or existing outputs", async () => {
  await using f = await fixture();
  await buildLiveClientUpdate(f.input);
  const envelope: unknown = JSON.parse(
    await NodeFSP.readFile(NodePath.join(f.outputDir, "manifest.json"), "utf8"),
  );
  const manifest = verifyManifest(envelope, f.publicKey);
  await verifyBundle(NodePath.join(f.outputDir, "client"), manifest);
  expect(manifest.files.map((entry) => entry.path)).toEqual(["assets/a.js", "index.html"]);
  expect(await NodeFSP.readdir(NodePath.join(f.outputDir, "client"))).toEqual([
    "assets",
    "index.html",
  ]);
  expect(await NodeFSP.readFile(NodePath.join(f.clientDir, ".vite/manifest.json"), "utf8")).toBe(
    '{"build":"metadata"}',
  );
  expect(await NodeFSP.readFile(NodePath.join(f.clientDir, "assets/a.js"), "utf8")).toBe(
    "console.log('new client')",
  );
  await expect(buildLiveClientUpdate(f.input)).rejects.toThrow("already exists");
  await expect(
    buildLiveClientUpdate({ ...f.input, outputDir: NodePath.join(f.clientDir, "output") }),
  ).rejects.toThrow("outside");
});

it("leaves no published bundle or staging files after invalid input", async () => {
  await using f = await fixture();
  await expect(buildLiveClientUpdate({ ...f.input, runtimeId: "not-a-digest" })).rejects.toThrow(
    "runtime identity",
  );
  expect(await NodeFSP.readdir(f.root)).toEqual(["source"]);
  await NodeFSP.symlink(
    NodePath.join(f.clientDir, "index.html"),
    NodePath.join(f.clientDir, "assets/link"),
  );
  await expect(buildLiveClientUpdate(f.input)).rejects.toThrow("symbolic links");
  expect(await NodeFSP.readdir(f.root)).toEqual(["source"]);
});

it("refuses an entry point with missing or different release metadata before publishing", async () => {
  await using f = await fixture();
  for (const html of [
    "<div>no version</div>",
    '<meta name="t3-live-client-version" content="1.2.2">',
  ]) {
    await NodeFSP.writeFile(NodePath.join(f.clientDir, "index.html"), html);
    await expect(buildLiveClientUpdate(f.input)).rejects.toThrow("signed version");
    expect(await NodeFSP.readdir(f.root)).toEqual(["source"]);
  }
});
