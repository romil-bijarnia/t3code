// @effect-diagnostics nodeBuiltinImport:off - Disposable Git repositories exercise actual compatibility input discovery.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { expect, it } from "vite-plus/test";

import { createLiveClientRuntimeId } from "./live-client-runtime-id.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-runtime-id-"));
  await execute("git", ["init", "-q", root]);
  const write = async (name: string, content: string) => {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, name), content);
  };
  await write("package.json", '{"name":"runtime","version":"1.0.0","engines":{"node":"26"}}');
  await write(".gitignore", "native/target/\n");
  await write("apps/server/src/runtime.ts", "server-v1");
  await write("apps/desktop/src/preload.ts", "bridge-v1");
  await write("apps/web/src/composerDraftStore.ts", "draft-v1");
  await write("apps/web/src/components/Greeting.tsx", "hello");
  await write("pnpm-lock.yaml", "lock-v1");
  await execute("git", ["-C", root, "add", "."]);
  return {
    root,
    write,
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

it("excludes stateless presentation, tests and ignored output but includes runtime and persistent-state changes", async () => {
  await using f = await fixture();
  const baseline = await createLiveClientRuntimeId(f.root);
  await f.write("apps/web/src/components/Greeting.tsx", "new UI");
  await f.write("apps/server/src/runtime.test.ts", "test-v2");
  await f.write("native/target/generated", "ignored output");
  expect(await createLiveClientRuntimeId(f.root)).toBe(baseline);
  for (const [name, before] of [
    ["apps/server/src/runtime.ts", "server-v1"],
    ["apps/desktop/src/preload.ts", "bridge-v1"],
    ["apps/web/src/composerDraftStore.ts", "draft-v1"],
    ["pnpm-lock.yaml", "lock-v1"],
  ] as const) {
    await f.write(name, "changed");
    expect(await createLiveClientRuntimeId(f.root)).not.toBe(baseline);
    await f.write(name, before);
  }
  await f.write("apps/server/src/new-untracked.ts", "new runtime code");
  expect(await createLiveClientRuntimeId(f.root)).not.toBe(baseline);
});

it("ignores only top-level package versions and deterministically includes public build configuration", async () => {
  await using f = await fixture();
  const baseline = await createLiveClientRuntimeId(f.root, { B: "two", A: "one" });
  expect(await createLiveClientRuntimeId(f.root, { A: "one", B: "two" })).toBe(baseline);
  await f.write("package.json", '{"name":"runtime","version":"2.0.0","engines":{"node":"26"}}');
  expect(await createLiveClientRuntimeId(f.root, { A: "one", B: "two" })).toBe(baseline);
  await f.write("package.json", '{"name":"runtime","version":"2.0.0","engines":{"node":"27"}}');
  expect(await createLiveClientRuntimeId(f.root, { A: "one", B: "two" })).not.toBe(baseline);
  expect(await createLiveClientRuntimeId(f.root, { A: "different", B: "two" })).not.toBe(baseline);
});
