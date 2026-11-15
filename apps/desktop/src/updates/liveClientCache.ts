// @effect-diagnostics nodeBuiltinImport:off - This cache belongs to the native profile protected by Electron's single-instance lock.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function prepareLiveClientCache(profileRoot: string) {
  const parent = NodePath.join(profileRoot, "live-client-cache");
  try {
    const stat = await NodeFSP.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Live client cache is not a private directory.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
  }
  const previous = (await NodeFSP.readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^session-[A-Za-z0-9]{6}$/.test(entry.name))
    .map((entry) => NodePath.join(parent, entry.name));
  const root = await NodeFSP.mkdtemp(NodePath.join(parent, "session-"));
  return {
    root,
    // Snapshot before allocating the new session: never prune its live asset generations.
    cleanup: async () => {
      for (const directory of previous)
        await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}
