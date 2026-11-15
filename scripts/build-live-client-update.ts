// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Offline release artifact producer.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  inspectLiveClientBundle,
  verifyBundle,
  verifyManifest,
  type LiveClientManifest,
  type SignedLiveClientManifest,
} from "../apps/desktop/src/updates/liveClientManifest.ts";

import { createLiveClientRuntimeId } from "./live-client-runtime-id.ts";

export async function buildLiveClientUpdate(input: {
  readonly clientDir: string;
  readonly outputDir: string;
  readonly version: string;
  readonly channel: "stable" | "nightly";
  readonly runtimeId: string;
  readonly privateKeyPem: string;
}): Promise<SignedLiveClientManifest> {
  const destination = NodePath.resolve(input.outputDir);
  const source = NodePath.resolve(input.clientDir);
  if (destination === source || destination.startsWith(source + NodePath.sep))
    throw new Error("Output must be outside the source client directory.");
  try {
    await NodeFSP.lstat(destination);
    throw new Error("Output directory already exists.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  const staging = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(destination), ".live-client-update-"),
  );
  try {
    const client = NodePath.join(staging, "client");
    await NodeFSP.mkdir(client);
    const files = await inspectLiveClientBundle(source, client, { omitBuildMetadata: true });
    const entry = files.find((file) => file.path === "index.html");
    if (!entry || entry.size > 1024 * 1024) {
      throw new Error("Live client index.html is missing or exceeds its size limit.");
    }
    const index = await NodeFSP.readFile(NodePath.join(client, "index.html"), "utf8");
    const versionTags = [...index.matchAll(/<meta\b[^>]*>/gi)].filter((match) =>
      /\sname\s*=\s*["']t3-live-client-version["']/i.test(match[0]),
    );
    const markers = [
      ...index.matchAll(
        /<meta\s+name=["']t3-live-client-version["']\s+content=["']([^"']+)["'][^>]*>/gi,
      ),
    ];
    if (versionTags.length !== 1 || markers.length !== 1 || markers[0]?.[1] !== input.version) {
      throw new Error("Live client index.html must identify exactly its signed version.");
    }
    const manifest: LiveClientManifest = {
      format: 1,
      version: input.version,
      channel: input.channel,
      runtimeId: input.runtimeId,
      files,
    };
    const payload = JSON.stringify(manifest);
    const envelope = {
      manifest: payload,
      signature: NodeCrypto.sign(null, Buffer.from(payload), input.privateKeyPem).toString(
        "base64",
      ),
    };
    const publicKey = NodeCrypto.createPublicKey(input.privateKeyPem)
      .export({ type: "spki", format: "pem" })
      .toString();
    verifyManifest(envelope, publicKey);
    await verifyBundle(client, manifest);
    await NodeFSP.writeFile(
      NodePath.join(staging, "manifest.json"),
      JSON.stringify(envelope) + "\n",
      {
        flag: "wx",
      },
    );
    await NodeFSP.rename(staging, destination);
    return envelope;
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "client-dir": { type: "string" },
      "output-dir": { type: "string" },
      version: { type: "string" },
      channel: { type: "string" },
      "runtime-id": { type: "string" },
      "runtime-root": { type: "string" },
      "private-key": { type: "string" },
    },
  });
  if (
    !values["client-dir"] ||
    !values["output-dir"] ||
    !values.version ||
    (!values["runtime-id"] && !values["runtime-root"]) ||
    (values["runtime-id"] !== undefined && values["runtime-root"] !== undefined) ||
    !values["private-key"] ||
    (values.channel !== "stable" && values.channel !== "nightly")
  ) {
    throw new Error(
      "Usage: build-live-client-update.ts --client-dir <path> --output-dir <new path> --version <version> --channel <stable|nightly> (--runtime-id <sha256> | --runtime-root <repository>) --private-key <pem path>",
    );
  }
  await buildLiveClientUpdate({
    clientDir: values["client-dir"],
    outputDir: values["output-dir"],
    version: values.version,
    channel: values.channel,
    runtimeId: values["runtime-root"]
      ? await createLiveClientRuntimeId(values["runtime-root"])
      : values["runtime-id"]!,
    privateKeyPem: await NodeFSP.readFile(values["private-key"], "utf8"),
  });
  console.log("Live client update prepared and verified.");
}
