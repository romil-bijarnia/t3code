// @effect-diagnostics nodeBuiltinImport:off - Offline compatibility identity for release preparation.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const inputRoots = [
  "apps/desktop",
  "apps/server",
  "apps/web",
  "packages",
  "native",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  "tsconfig.base.json",
  "tsconfig.effect.json",
  "vite.config.ts",
  ".npmrc",
  ".gitattributes",
];

function isRuntimeInput(name: string): boolean {
  if (
    /(?:^|\/)(?:node_modules|dist|dist-electron|target|\.t3|\.vite-plus|test|tests|__tests__|fixtures|__fixtures__|docs)(?:\/|$)/.test(
      name,
    ) ||
    /\.(?:test|spec)(?:\.[^.]+)?\.[^.]+$/.test(name) ||
    /\.(?:md|mdx|snap|png|jpe?g|gif|webp|ico|svg|mp4|pdf)$/i.test(name)
  )
    return false;
  if (!name.includes("/")) return inputRoots.includes(name);
  if (
    /^apps\/(?:desktop|server)\/src\//.test(name) ||
    /^apps\/(?:desktop|server|web)\/scripts\//.test(name)
  )
    return true;
  if (
    /^packages\/[^/]+\/src\//.test(name) ||
    name.startsWith("native/") ||
    name.startsWith("scripts/")
  )
    return true;
  if (/^(?:apps\/(?:desktop|server|web)|packages\/[^/]+)\/[^/]+$/.test(name)) {
    return /\/(?:package\.json|[^/]*config\.[^/]+|Cargo\.(?:toml|lock))$/.test(name);
  }
  if (/^apps\/(?:desktop|server|web)\/(?:vite|build)\//.test(name)) return true;
  if (!name.startsWith("apps/web/src/")) return false;
  return (
    /\/(?:appInit|main|bootstrap|composerDraftStore|questionAttachments|pendingUserInput)\.[^/]+$/.test(
      name,
    ) ||
    /Store\.ts$/.test(name) ||
    /^apps\/web\/src\/(?:state|rpc)\//.test(name) ||
    /^apps\/web\/src\/lib\/liveClientUpdate[^/]*\.[^/]+$/.test(name)
  );
}

function packageBytes(bytes: Buffer): Buffer {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Invalid runtime package manifest.");
  const manifest: Record<string, unknown> = { ...parsed };
  delete manifest.version;
  return Buffer.from(JSON.stringify(manifest));
}

export async function createLiveClientRuntimeId(
  root: string,
  buildConfig: Readonly<Record<string, string>> = {},
): Promise<string> {
  const options = { cwd: NodePath.resolve(root), maxBuffer: 8 * 1024 * 1024 };
  const prefix = await execute("git", ["rev-parse", "--show-prefix"], options);
  if (prefix.stdout.trim() !== "") throw new Error("Runtime root must be the repository root.");
  const listed = await execute(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...inputRoots],
    options,
  );
  const names = [
    ...new Set(listed.stdout.split("\0").filter((name) => name && isRuntimeInput(name))),
  ].sort();
  if (names.length === 0 || names.length > 50_000) throw new Error("Invalid runtime input count.");
  const entries = Object.entries(buildConfig).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (
    entries.length > 1024 ||
    entries.some(
      ([key, value]) => key.length > 1024 || typeof value !== "string" || value.length > 16_384,
    )
  )
    throw new Error("Invalid runtime build configuration.");
  const hash = NodeCrypto.createHash("sha256")
    .update("t3-live-client-runtime-v1\n")
    .update(JSON.stringify(entries));
  let total = 0;
  for (const name of names) {
    const file = NodePath.join(root, name);
    const stat = await NodeFSP.lstat(file).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) continue;
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (total += stat.size) > 256 * 1024 * 1024)
      throw new Error("Invalid runtime input file.");
    const original = await NodeFSP.readFile(file);
    if (original.length !== stat.size) throw new Error("Runtime input changed while reading.");
    const bytes =
      name.endsWith("/package.json") || name === "package.json" ? packageBytes(original) : original;
    hash
      .update(JSON.stringify([name, bytes.length]))
      .update("\n")
      .update(bytes);
  }
  return hash.digest("hex");
}
