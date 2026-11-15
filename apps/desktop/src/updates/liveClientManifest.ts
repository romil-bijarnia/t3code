// @effect-diagnostics nodeBuiltinImport:off - Bundle verification runs in the desktop main process.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const LIVE_CLIENT_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
export const LIVE_CLIENT_MAX_FILES = 20_000;
export const LIVE_CLIENT_MAX_BYTES = 256 * 1024 * 1024;

export interface LiveClientManifest {
  readonly format: 1;
  readonly version: string;
  readonly channel: "stable" | "nightly";
  readonly runtimeId: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }>;
}

export interface SignedLiveClientManifest {
  readonly manifest: string;
  readonly signature: string;
}

function fail(message: string): never {
  throw new Error(`Invalid live client update: ${message}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function validatePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value !== value.normalize("NFC") ||
    !value.isWellFormed() ||
    /[\\\x00-\x1f\x7f?#%:*"<>|]/.test(value)
  )
    fail("noncanonical file path");
  const segments = value.split("/");
  if (
    segments.length > 64 ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    )
  )
    fail("noncanonical file path");
}

function validateManifest(value: unknown): LiveClientManifest {
  if (!isRecord(value) || value.format !== 1) fail("unsupported manifest format");
  const { version, channel, runtimeId, files } = value;
  if (typeof version !== "string" || version.length > 128 || !versionPattern.test(version)) {
    fail("noncanonical version");
  }
  const segments = version.split(/[.-]/);
  if (segments.some((segment) => /^\d+$/.test(segment) && !Number.isSafeInteger(Number(segment))))
    fail("version number is too large");
  const prerelease = versionPattern.exec(version)?.[4];
  if (
    (channel !== "stable" && channel !== "nightly") ||
    (channel === "stable" ? prerelease !== undefined : !prerelease?.startsWith("nightly."))
  )
    fail("version does not match channel");
  if (typeof runtimeId !== "string" || !digestPattern.test(runtimeId))
    fail("invalid runtime identity");
  if (!Array.isArray(files) || files.length === 0 || files.length > LIVE_CLIENT_MAX_FILES) {
    fail("invalid file count");
  }
  let total = 0;
  const names = new Map<string, string>();
  const fileNames = new Set<string>();
  const result: Array<LiveClientManifest["files"][number]> = [];
  for (const file of files) {
    if (!isRecord(file)) fail("invalid file entry");
    validatePath(file.path);
    if (typeof file.sha256 !== "string" || !digestPattern.test(file.sha256))
      fail("invalid file digest");
    if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) {
      fail("invalid file size");
    }
    total += file.size;
    if (total > LIVE_CLIENT_MAX_BYTES) fail("bundle exceeds size limit");
    if (fileNames.has(file.path)) fail("duplicate file path");
    const segments = file.path.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      const previous = names.get(prefix.toLowerCase());
      if (previous !== undefined && previous !== prefix) fail("case-colliding paths");
      names.set(prefix.toLowerCase(), prefix);
    }
    fileNames.add(file.path);
    result.push({ path: file.path, sha256: file.sha256, size: file.size });
  }
  for (const file of result) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (fileNames.has(parts.slice(0, index).join("/"))) fail("file is also a directory");
    }
  }
  if (!fileNames.has("index.html")) fail("missing index.html");
  return { format: 1, version, channel, runtimeId, files: result };
}

export function verifyManifest(envelope: unknown, publicKeyPem: string): LiveClientManifest {
  if (
    !isRecord(envelope) ||
    typeof envelope.manifest !== "string" ||
    typeof envelope.signature !== "string"
  ) {
    fail("invalid signed envelope");
  }
  if (Buffer.byteLength(envelope.manifest, "utf8") > LIVE_CLIENT_MANIFEST_MAX_BYTES)
    fail("manifest exceeds size limit");
  const payload = Buffer.from(envelope.manifest, "utf8");
  if (envelope.signature.length !== 88 || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))
    fail("invalid signature encoding");
  const signature = Buffer.from(envelope.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== envelope.signature)
    fail("invalid signature encoding");
  const key = NodeCrypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519" || !NodeCrypto.verify(null, payload, key, signature))
    fail("signature verification failed");
  return validateManifest(JSON.parse(envelope.manifest));
}

/** Copies the same bounded bytes it hashes when preparing a release. */
export async function inspectLiveClientBundle(
  directory: string,
  copyTo?: string,
  options: { readonly omitBuildMetadata?: boolean } = {},
): Promise<LiveClientManifest["files"]> {
  if (!(await NodeFSP.lstat(directory)).isDirectory()) fail("bundle root is not a directory");
  const files: Array<LiveClientManifest["files"][number]> = [];
  let total = 0;
  let entries = 0;
  const walk = async (relative: string): Promise<void> => {
    const dir = await NodeFSP.opendir(NodePath.join(directory, relative));
    for await (const entry of dir) {
      if (
        relative === "" &&
        entry.name === ".vite" &&
        entry.isDirectory() &&
        options.omitBuildMetadata === true
      )
        continue;
      entries += 1;
      if (entries > LIVE_CLIENT_MAX_FILES * 2) fail("too many directory entries");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      validatePath(name);
      const source = NodePath.join(directory, name);
      const stat = await NodeFSP.lstat(source);
      if (stat.isSymbolicLink()) fail("symbolic links are not allowed");
      if (stat.isDirectory()) {
        if (copyTo !== undefined)
          await NodeFSP.mkdir(NodePath.join(copyTo, name), { recursive: true });
        await walk(name);
        continue;
      }
      if (
        !stat.isFile() ||
        files.length >= LIVE_CLIENT_MAX_FILES ||
        stat.size > LIVE_CLIENT_MAX_BYTES - total
      )
        fail("invalid or oversized bundle file");
      const input = await NodeFSP.open(
        source,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
      );
      let output: NodeFSP.FileHandle | undefined;
      try {
        if (copyTo !== undefined) output = await NodeFSP.open(NodePath.join(copyTo, name), "wx");
        if (!(await input.stat()).isFile()) fail("bundle entry is not a regular file");
        const hash = NodeCrypto.createHash("sha256");
        let size = 0;
        for await (const chunk of input.createReadStream({
          autoClose: false,
          highWaterMark: 64 * 1024,
        })) {
          size += chunk.length;
          total += chunk.length;
          if (total > LIVE_CLIENT_MAX_BYTES || size > stat.size)
            fail("bundle changed or exceeds size limit");
          hash.update(chunk);
          if (output !== undefined) await output.writeFile(chunk);
        }
        if (size !== stat.size) fail("bundle changed while reading");
        files.push({ path: name, size, sha256: hash.digest("hex") });
      } finally {
        await Promise.all([input.close(), output?.close()]);
      }
    }
  };
  await walk("");
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function verifyBundle(directory: string, manifest: LiveClientManifest): Promise<void> {
  const expected = validateManifest(manifest).files;
  const actual = await inspectLiveClientBundle(directory);
  if (expected.length !== actual.length) fail("bundle file set differs from manifest");
  const records = new Map(expected.map((file) => [file.path, file]));
  for (const file of actual) {
    const record = records.get(file.path);
    if (!record || record.size !== file.size || record.sha256 !== file.sha256)
      fail("bundle file differs from manifest");
  }
}
