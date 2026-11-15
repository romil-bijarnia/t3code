// @effect-diagnostics nodeBuiltinImport:off - Real filesystem fixtures and ephemeral signing keys exercise release verification.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  LIVE_CLIENT_MANIFEST_MAX_BYTES,
  LIVE_CLIENT_MAX_BYTES,
  LIVE_CLIENT_MAX_FILES,
  verifyBundle,
  verifyManifest,
  type LiveClientManifest,
} from "./liveClientManifest.ts";

const file = (name: string, content = "ok") => ({
  path: name,
  size: Buffer.byteLength(content),
  sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
});

function fixture() {
  const keys = NodeCrypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const manifest: LiveClientManifest = {
    format: 1,
    version: "1.2.3",
    channel: "stable",
    runtimeId: "a".repeat(64),
    files: [file("index.html")],
  };
  const signed = (value: unknown) => {
    const payload = JSON.stringify(value);
    return {
      manifest: payload,
      signature: NodeCrypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64"),
    };
  };
  return { publicKey, manifest, signed };
}

async function directory() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-live-manifest-"));
  return { root, [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }) };
}

describe("live client manifest", () => {
  it("authenticates the exact payload using the pinned publisher key", () => {
    const f = fixture();
    const envelope = f.signed(f.manifest);
    expect(verifyManifest(envelope, f.publicKey)).toEqual(f.manifest);
    expect(() =>
      verifyManifest({ ...envelope, manifest: envelope.manifest + " " }, f.publicKey),
    ).toThrow("signature verification");
    expect(() => verifyManifest(envelope, fixture().publicKey)).toThrow("signature verification");
    expect(() =>
      verifyManifest({ ...envelope, signature: envelope.signature + "\n" }, f.publicKey),
    ).toThrow("signature encoding");
    expect(() =>
      verifyManifest(
        { manifest: " ".repeat(LIVE_CLIENT_MANIFEST_MAX_BYTES + 1), signature: envelope.signature },
        f.publicKey,
      ),
    ).toThrow("size limit");
    expect(() =>
      verifyManifest(
        {
          manifest: "é".repeat(LIVE_CLIENT_MANIFEST_MAX_BYTES / 2 + 1),
          signature: envelope.signature,
        },
        f.publicKey,
      ),
    ).toThrow("size limit");
    const rsa = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      verifyManifest(envelope, rsa.publicKey.export({ format: "pem", type: "spki" }).toString()),
    ).toThrow("signature verification");
  });

  it.each([
    "../escape",
    "/index.html",
    "assets/../escape",
    "assets//x",
    "assets/./x",
    "assets\\x",
    "assets/x?query",
    "assets/x#fragment",
    "assets/%2e%2e/x",
    "assets/\0x",
    "C:/x",
    "assets/CON.txt",
    "assets/x.",
    "assets/x ",
    "assets/\ud800",
    "assets/e\u0301.js",
  ])("rejects noncanonical path %s", (name) => {
    const f = fixture();
    expect(() =>
      verifyManifest(
        f.signed({ ...f.manifest, files: [...f.manifest.files, file(name)] }),
        f.publicKey,
      ),
    ).toThrow("file path");
  });

  it("rejects ambiguous file sets, missing entry points and oversized declarations", () => {
    const f = fixture();
    for (const files of [
      [file("index.html"), file("index.html")],
      [file("index.html"), file("assets/A.js"), file("assets/a.js")],
      [file("index.html"), file("Assets/a.js"), file("assets/b.js")],
      [file("index.html"), file("assets"), file("assets/a.js")],
      [file("assets/a.js")],
      [file("index.html"), { ...file("huge"), size: LIVE_CLIENT_MAX_BYTES }],
      Array.from({ length: LIVE_CLIENT_MAX_FILES + 1 }, (_, index) => file(`a${index}`)),
      [{ ...file("index.html"), size: -1 }],
      [{ ...file("index.html"), size: 0.5 }],
      [{ ...file("index.html"), sha256: "a" }],
    ])
      expect(() => verifyManifest(f.signed({ ...f.manifest, files }), f.publicKey)).toThrow();
    for (const version of ["v1.2.3", "01.2.3", "1.2", "1.2.3-nightly.01", "1.2.3-preview.1"]) {
      expect(() => verifyManifest(f.signed({ ...f.manifest, version }), f.publicKey)).toThrow();
    }
    expect(() =>
      verifyManifest(
        f.signed({ ...f.manifest, channel: "nightly", version: "1.2.3-foo-nightly.1" }),
        f.publicKey,
      ),
    ).toThrow("channel");
    const nightly = { ...f.manifest, channel: "nightly", version: "1.2.3-nightly.20261115.1" };
    expect(verifyManifest(f.signed(nightly), f.publicKey).version).toBe(nightly.version);
  });

  it("checks exact contents, missing and extra files, and refuses links", async () => {
    const f = fixture();
    await using d = await directory();
    await NodeFSP.writeFile(NodePath.join(d.root, "index.html"), "ok");
    await verifyBundle(d.root, f.manifest);
    await expect(
      verifyBundle(d.root, { ...f.manifest, files: [{ ...file("index.html"), size: 3 }] }),
    ).rejects.toThrow("differs");
    const linkedRoot = NodePath.join(d.root, "root-link");
    await NodeFSP.symlink(d.root, linkedRoot, "dir");
    await expect(verifyBundle(linkedRoot, f.manifest)).rejects.toThrow("root is not a directory");
    await NodeFSP.rm(linkedRoot);
    await NodeFSP.writeFile(NodePath.join(d.root, "index.html"), "no");
    await expect(verifyBundle(d.root, f.manifest)).rejects.toThrow("differs");
    await NodeFSP.rm(NodePath.join(d.root, "index.html"));
    await expect(verifyBundle(d.root, f.manifest)).rejects.toThrow("file set");
    await NodeFSP.writeFile(NodePath.join(d.root, "index.html"), "ok");
    await NodeFSP.writeFile(NodePath.join(d.root, "extra.js"), "extra");
    await expect(verifyBundle(d.root, f.manifest)).rejects.toThrow("file set");
    await NodeFSP.rm(NodePath.join(d.root, "extra.js"));
    await NodeFSP.mkdir(NodePath.join(d.root, ".vite"));
    await NodeFSP.writeFile(NodePath.join(d.root, ".vite/manifest.json"), "{}");
    await expect(verifyBundle(d.root, f.manifest)).rejects.toThrow("file set");
    await NodeFSP.rm(NodePath.join(d.root, ".vite"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(d.root, "other"));
    await NodeFSP.symlink(NodePath.join(d.root, "index.html"), NodePath.join(d.root, "other/link"));
    await expect(verifyBundle(d.root, f.manifest)).rejects.toThrow("symbolic links");
  });
});
