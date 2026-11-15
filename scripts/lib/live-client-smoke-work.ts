// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Real process/file milestones use a bounded deadline outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimers from "node:timers";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import type { Page } from "playwright-core";

// This helper is also checked by the server's DOM-free TypeScript project.
// Describe only the browser-side capabilities used by serialized callbacks.
interface SmokeBrowserContext {
  readonly location: { hash: string };
  readonly document: { readonly activeElement: { blur(): void } | null };
  getSelection(): { removeAllRanges(): void } | null;
}

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const APPROVAL_INSTANCE = "liveClientSmokeReplayApproval";
const STREAM_INSTANCE = "liveClientSmokeReplayStream";
const APPROVAL_TITLE = "Live update pending approval";
const STREAM_TITLE = "Live update streaming replay";
const STREAM_MODEL = "todo-list";
const HISTORICAL_THREAD = "launch-check-thread";
const PROJECT_ID = "launch-check-project";

interface Locations {
  readonly repoRoot: string;
  readonly t3Home: string;
  readonly home: string;
}

const requireTrue = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

function locations(input: Locations) {
  const home = NodePath.resolve(input.home);
  const t3Home = NodePath.resolve(input.t3Home);
  requireTrue(
    t3Home.startsWith(home + NodePath.sep),
    "T3 home must be inside the disposable smoke home.",
  );
  return {
    workspace: NodePath.join(home, "continuity-project"),
    bootstrap: NodePath.join(home, "slow-replay.mjs"),
    trace: NodePath.join(home, "replay-emissions.ndjson"),
    heartbeat: NodePath.join(home, "heartbeat.json"),
    terminalReady: NodePath.join(home, "terminal-ready"),
    reattachedShell: NodePath.join(home, "reattached-shell-ready"),
    releaseReplay: NodePath.join(home, "release-replay-clock"),
    heartbeatScript: NodePath.join(home, "continuity-project", "heartbeat.py"),
    agent: NodePath.join(input.repoRoot, "apps/server/scripts/dev-replay-agent.ts"),
    database: NodePath.join(t3Home, "userdata/statev2.sqlite"),
  };
}

/** Call before launching the disposable desktop app; no paid provider is selected. */
export async function seedLiveClientSmokeWork(input: Locations): Promise<void> {
  const paths = locations(input);
  await NodeFSP.access(paths.database);
  const transcript = await NodeFSP.readFile(
    NodePath.join(
      input.repoRoot,
      "apps/server/src/orchestration-v2/testkit/fixtures/todo_list/registry_transcript.ndjson",
    ),
    "utf8",
  );
  const replaySource = await NodeFSP.readFile(paths.agent, "utf8");
  const chunkSize = Number(replaySource.match(/const WORDS_PER_CHUNK = (\d+);/)?.[1]);
  requireTrue(
    Number.isSafeInteger(chunkSize) && chunkSize > 0,
    "The official Replay chunk size could not be established.",
  );
  let textChunks = 0;
  for (const line of transcript.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as {
      type?: string;
      frame?: {
        kind?: string;
        params?: {
          update?: { sessionUpdate?: string; content?: { type?: string; text?: string } };
        };
      };
    };
    requireTrue(
      entry.type !== "emit_inbound" || entry.frame?.kind !== "request",
      "The official streaming replay unexpectedly contains an agent request.",
    );
    const update = entry.frame?.params?.update;
    if (
      entry.type === "emit_inbound" &&
      (update?.sessionUpdate === "agent_message_chunk" ||
        update?.sessionUpdate === "agent_thought_chunk") &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      textChunks += Math.ceil((update.content.text.match(/\S+\s*|\s+/g)?.length ?? 0) / chunkSize);
    }
  }
  requireTrue(
    textChunks >= 3,
    "The official streaming replay must emit at least three actual text chunks.",
  );
  await NodeFSP.access(NodePath.join(input.t3Home, "userdata/server-runtime.json")).then(
    () => {
      throw new Error("Continuity fixture seeding is allowed only before server launch.");
    },
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    },
  );
  await NodeFSP.mkdir(NodePath.join(input.t3Home, "userdata"), { recursive: true });
  await NodeFSP.mkdir(paths.workspace, { recursive: true });
  await execute("git", ["init", "-q", paths.workspace]);
  await NodeFSP.writeFile(
    NodePath.join(paths.workspace, "README.md"),
    "Disposable live-client update continuity project.\n",
    { flag: "wx" },
  );
  await execute("git", ["-C", paths.workspace, "add", "README.md"]);
  await execute("git", [
    "-C",
    paths.workspace,
    "-c",
    "user.name=Smoke fixture",
    "-c",
    "user.email=smoke@example.invalid",
    "commit",
    "-qm",
    "Seed isolated continuity fixture",
  ]);
  const database = new NodeSqlite.DatabaseSync(paths.database);
  try {
    const changed = database
      .prepare("UPDATE projection_projects SET workspace_root = ? WHERE project_id = ?")
      .run(paths.workspace, PROJECT_ID);
    requireTrue(
      Number(changed.changes) === 1,
      "The disposable release fixture has no launch-check-project row.",
    );
  } finally {
    database.close();
  }
  await NodeFSP.writeFile(paths.trace, "", { flag: "wx", mode: 0o600 });
  await NodeFSP.writeFile(
    paths.bootstrap,
    `
import * as fs from 'node:fs';
const trace = ${JSON.stringify(paths.trace)};
let sequence = 0;
const role = new URL(import.meta.url).searchParams.get('role');
fs.appendFileSync(trace, JSON.stringify({kind:'started',pid:process.pid,role})+'\\n');
const schedule = globalThis.setTimeout;
const gate = ${JSON.stringify(paths.releaseReplay)};
let shortTimers = 0;
if (role === 'stream') globalThis.setTimeout = (fn, ms, ...args) => {
  if (!(ms >= 0 && ms <= 30) || shortTimers++ === 0) return schedule(fn,ms,...args);
  if (fs.existsSync(gate)) return schedule(fn,15000,...args);
  return schedule(() => {
    const watcher = fs.watch(${JSON.stringify(input.home)}, () => release());
    let released = false;
    function release() {
      if (released || !fs.existsSync(gate)) return;
      released = true; watcher.close(); schedule(fn,15000,...args);
    }
    release();
  },0);
};
const write = process.stdout.write.bind(process.stdout);
let pending = '';
process.stdout.write = function(chunk, ...args) {
  pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  for (;;) {
    const end = pending.indexOf('\\n');
    if (end < 0) break;
    const line = pending.slice(0,end); pending = pending.slice(end+1);
    try {
      const message = JSON.parse(line);
      if (message.method === 'session/update' || message.method === 'session/request_permission') {
        const update = message.params?.update;
        const textChunk = (update?.sessionUpdate === 'agent_message_chunk' || update?.sessionUpdate === 'agent_thought_chunk') && update.content?.type === 'text';
        fs.appendFileSync(trace, JSON.stringify({kind:message.method,pid:process.pid,role,sequence:++sequence,textChunk})+'\\n');
      }
    } catch {}
  }
  return write(chunk,...args);
};
`,
    { flag: "wx", mode: 0o600 },
  );
  const settingsFile = NodePath.join(input.t3Home, "userdata/settings.json");
  const settings: Record<string, unknown> = await NodeFSP.readFile(settingsFile, "utf8").then(
    (text) => JSON.parse(text) as Record<string, unknown>,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw error;
    },
  );
  const instances = settings.providerInstances;
  const replayInstance = (role: "approval" | "stream") => {
    const bootstrapUrl = NodeURL.pathToFileURL(paths.bootstrap);
    bootstrapUrl.searchParams.set("role", role);
    return {
      driver: "acpRegistry",
      displayName: `Replay continuity smoke (${role})`,
      enabled: true,
      config: {
        source: "local",
        commandPath: process.execPath,
        commandArgs: ["--import", bootstrapUrl.href, paths.agent],
      },
    };
  };
  await NodeFSP.writeFile(
    settingsFile,
    JSON.stringify({
      ...settings,
      enableProviderUpdateChecks: false,
      defaultRuntimeMode: "approval-required",
      defaultModelSelection: { instanceId: STREAM_INSTANCE, model: STREAM_MODEL },
      fallbackModelSelection: null,
      providerInstances: {
        ...(typeof instances === "object" && instances !== null ? instances : {}),
        [APPROVAL_INSTANCE]: replayInstance("approval"),
        [STREAM_INSTANCE]: replayInstance("stream"),
      },
    }) + "\n",
    { mode: 0o600 },
  );
}

async function waitForFileFact<T>(
  file: string,
  read: (text: string) => T | undefined,
  timeoutMs = 90_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let reading = false;
    let settled = false;
    const watcher = NodeFS.watch(NodePath.dirname(file), () => {
      void inspect();
    });
    const finish = (error: Error | undefined, value?: T) => {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value!);
    };
    const deadline = NodeTimers.setTimeout(
      () => finish(new Error(`No continuity milestone in ${NodePath.basename(file)}.`)),
      timeoutMs,
    );
    watcher.on("error", (error) => finish(error));
    async function inspect() {
      if (reading || settled) return;
      reading = true;
      try {
        const text = await NodeFSP.readFile(file, "utf8").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
          throw error;
        });
        const value = read(text);
        if (value !== undefined) finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      } finally {
        reading = false;
      }
    }
    void inspect();
  });
}

async function waitForPersistedAssistantGrowth(
  file: string,
  read: () => number,
  before: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const watcher = NodeFS.watch(NodePath.dirname(file), () => inspect());
    const deadline = NodeTimers.setTimeout(
      () =>
        finish(
          new Error(
            "Replay emitted text, but no fresh assistant text was persisted after activation.",
          ),
        ),
      90_000,
    );
    function finish(error?: Error, value?: number) {
      if (settled) return;
      settled = true;
      watcher.close();
      NodeTimers.clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value!);
    }
    function inspect() {
      if (settled) return;
      try {
        const count = read();
        if (count > before) finish(undefined, count);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
    watcher.on("error", (error) => finish(error));
    inspect();
  });
}

async function ownedProcesses(root: number) {
  const queue = [root];
  const seen = new Set<number>();
  const result: Array<{ pid: number; command: string; start: string }> = [];
  for (const pid of queue) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const command = await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    if (stat)
      result.push({
        pid,
        command,
        start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "",
      });
    const children = await NodeFSP.readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(
      () => "",
    );
    for (const value of children.trim().split(/\s+/)) {
      const child = Number(value);
      if (Number.isSafeInteger(child) && child > 0) queue.push(child);
    }
  }
  return result;
}

interface ThreadRead {
  thread: {
    threadId: string;
    activeRunId: string | null;
    latestRunId: string | null;
    runCount: number;
    pendingRequestCount: number;
    status: string;
  };
  messages: Array<{ role: string; text: string }>;
}

/** Call after app startup; it leaves the historical smoke thread selected with terminal closed. */
export async function prepareLiveClientSmokeWork(
  input: Locations & { readonly page: Page; readonly mainPid: number },
) {
  const paths = locations(input);
  const page = input.page;
  const cli = (...args: string[]) =>
    execute(
      process.execPath,
      [NodePath.join(input.repoRoot, "apps/server/dist/bin.mjs"), ...args],
      {
        cwd: paths.workspace,
        env: { ...process.env, T3CODE_HOME: input.t3Home, T3CODE_TELEMETRY_ENABLED: "false" },
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  const json = async <T>(args: string[]): Promise<T> => {
    const { stdout } = await cli(...args);
    for (const line of stdout.trim().split("\n").reverse()) {
      try {
        return JSON.parse(line) as T;
      } catch {}
    }
    throw new Error("The isolated thread CLI returned no JSON result.");
  };
  const show = (thread: string) =>
    json<ThreadRead>(["thread", "show", "--base-dir", input.t3Home, thread, "--json"]);
  const original = new URL(page.url());
  const originalRoute = (original.hash ? original.hash.slice(1) : original.pathname).split("?")[0]!;
  const originalParts = originalRoute.split("/").filter(Boolean).map(decodeURIComponent);
  const environmentId = originalParts[0];
  if (!environmentId || originalParts[1] !== HISTORICAL_THREAD) {
    throw new Error("Active-work preparation requires the already-open seeded historical thread.");
  }
  const openThread = async (threadId: string) => {
    try {
      await page.evaluate(
        ({ environmentId, threadId }) => {
          const browser = globalThis as unknown as SmokeBrowserContext;
          browser.location.hash = `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
        },
        { environmentId, threadId },
      );
      await page.waitForURL((url) => {
        const route = url.hash ? url.hash.slice(1) : url.pathname;
        const segments = route.split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
        return segments[0] === environmentId && segments[1] === threadId;
      });
    } catch (error) {
      throw new Error(`Opening real fixture thread ${threadId} failed: ${String(error)}`, {
        cause: error,
      });
    }
  };
  const waitForApprovalControl = async () => {
    const approval = page
      .getByRole("button", { name: /^(?:Allow once|Approve)$/ })
      .filter({ visible: true })
      .first();
    await approval.waitFor();
    requireTrue(await approval.isEnabled(), "The pending approval has no live response control.");
  };
  await NodeFSP.access(paths.bootstrap);
  const start = (title: string, model: string) =>
    json<{ threadId: string; runId: string | null }>([
      "thread",
      "start",
      "--base-dir",
      input.t3Home,
      PROJECT_ID,
      "Play the official free replay fixture.",
      "--provider",
      model === "approval" ? APPROVAL_INSTANCE : STREAM_INSTANCE,
      "--model",
      model,
      "--title",
      title,
      "--json",
    ]);
  const approval = await start(APPROVAL_TITLE, "approval");
  await openThread(approval.threadId);
  await waitForApprovalControl();
  const approvalBefore = await show(approval.threadId);
  requireTrue(
    approvalBefore.thread.pendingRequestCount > 0,
    "Replay did not retain a pending approval.",
  );
  const streaming = await start(STREAM_TITLE, STREAM_MODEL);
  await openThread(streaming.threadId);
  await page.getByRole("button", { name: "Stop generation", exact: true }).waitFor();

  await NodeFSP.writeFile(
    paths.heartbeatScript,
    `import json,os,pathlib,time\np=pathlib.Path(${JSON.stringify(paths.heartbeat)})\nn=0\nwhile True:\n n+=1\n t=p.with_suffix('.tmp')\n t.write_text(json.dumps({'pid':os.getpid(),'beats':n}))\n t.replace(p)\n print('T3 live-update heartbeat',n,flush=True)\n time.sleep(0.25)\n`,
    { flag: "wx" },
  );
  const toggle = page.getByRole("button", { name: "Toggle terminal drawer", exact: true });
  await toggle.click();
  const terminal = page.locator(
    'textarea[aria-label="Terminal input"][data-workspace-focus-default]',
  );
  await terminal.waitFor({ state: "attached" });
  requireTrue(
    await terminal.evaluate((input) => "readOnly" in input && input.readOnly === false),
    "The initialized terminal has no write permission.",
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  let terminalReady = false;
  let lastProbeError: unknown;
  for (let attempt = 0; attempt < 3 && !terminalReady; attempt += 1) {
    await terminal.focus();
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+u");
    await page.keyboard.insertText(`printf ready > ${quote(paths.terminalReady)}`);
    await page.keyboard.press("Enter");
    try {
      await waitForFileFact(
        paths.terminalReady,
        (text) => (text === "ready" ? true : undefined),
        8_000,
      );
      terminalReady = true;
    } catch (error) {
      lastProbeError = error;
    }
  }
  if (!terminalReady)
    throw new Error(
      "T3 terminal readiness probe failed after three bounded attempts; no heartbeat was launched.",
      { cause: lastProbeError },
    );
  await terminal.focus();
  await page.keyboard.insertText(`python3 -u ${quote(paths.heartbeatScript)}`);
  await page.keyboard.press("Enter");
  const heartbeatBefore = await waitForFileFact<{ pid: number; beats: number }>(
    paths.heartbeat,
    (text) => {
      if (!text) return undefined;
      const value = JSON.parse(text) as { pid: number; beats: number };
      return value.beats > 0 ? value : undefined;
    },
    15_000,
  ).catch((error: unknown) => {
    throw new Error(
      "The single T3-owned Python heartbeat did not report after the shell readiness milestone; it was not retried.",
      { cause: error },
    );
  });
  await toggle.click();
  await openThread(HISTORICAL_THREAD);
  await page.evaluate(() => {
    const browser = globalThis as unknown as SmokeBrowserContext;
    browser.document.activeElement?.blur();
    browser.getSelection()?.removeAllRanges();
  });
  const traceRecords = (
    text: string,
  ): Array<{ kind: string; pid: number; sequence?: number; textChunk?: boolean }> =>
    text
      .split("\n")
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const traceBefore = await waitForFileFact(paths.trace, (text) => {
    const active = new Set(
      traceRecords(text)
        .filter((entry) => entry.kind !== "started")
        .map((entry) => entry.pid),
    );
    return active.size >= 2 ? text : undefined;
  });
  const replayPids = new Set(
    traceRecords(traceBefore)
      .filter((entry) => entry.kind !== "started")
      .map((entry) => entry.pid),
  );
  const beforeProcesses = await ownedProcesses(input.mainPid);
  const monitored = beforeProcesses.filter(
    (entry) =>
      (entry.command.includes(paths.agent) && replayPids.has(entry.pid)) ||
      entry.command.includes(paths.heartbeatScript),
  );
  requireTrue(
    monitored.some((entry) => entry.pid === heartbeatBefore.pid),
    "Heartbeat is not owned by the isolated desktop process.",
  );
  requireTrue(
    monitored.filter((entry) => entry.command.includes(paths.agent)).length >= 2,
    "Both official Replay child processes were not found.",
  );
  const emittedBefore = traceRecords(traceBefore).filter(
    (entry) => entry.textChunk === true,
  ).length;
  const database = new NodeSqlite.DatabaseSync(paths.database, { readOnly: true });
  const ids = [approval.threadId, streaming.threadId];
  const readRows = (table: string, columns: string) =>
    database
      .prepare(`SELECT ${columns} FROM ${table} WHERE thread_id IN (?,?) ORDER BY thread_id,1`)
      .all(...ids);
  const baseline = {
    runs: readRows("orchestration_v2_projection_runs", "run_id, thread_id, status"),
    attempts: readRows("orchestration_v2_projection_run_attempts", "attempt_id, run_id, status"),
    requests: readRows(
      "orchestration_v2_projection_runtime_requests",
      "runtime_request_id, thread_id, status, resolved_at",
    ),
  };
  const assistantCharacters = () =>
    Number(
      database
        .prepare(
          "SELECT COALESCE(SUM(length(COALESCE(json_extract(payload_json, '$.text'), ''))), 0) AS characters FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role = 'assistant'",
        )
        .get(streaming.threadId)?.characters ?? 0,
    );
  const high =
    database
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS sequence FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id IN (?,?)",
      )
      .get(...ids)?.sequence ?? 0;
  requireTrue(
    Number(high) > 0,
    "The canonical event log contains no actual fixture-thread events.",
  );

  return {
    approvalThreadId: approval.threadId,
    streamingThreadId: streaming.threadId,
    monitoredPids: monitored.map(({ pid, start }) => ({ pid, start })),
    async verify() {
      const heartbeatAtVerification = JSON.parse(
        await NodeFSP.readFile(paths.heartbeat, "utf8"),
      ) as { pid: number; beats: number };
      const emissionsAtVerification = traceRecords(
        await NodeFSP.readFile(paths.trace, "utf8"),
      ).filter((entry) => entry.textChunk === true).length;
      const persistedCharactersBefore = assistantCharacters();
      requireTrue(
        persistedCharactersBefore > 0,
        "The initial Replay text was not persisted before activation verification.",
      );
      await NodeFSP.writeFile(paths.releaseReplay, "release\n", { mode: 0o600 });
      const heartbeatAfter = await waitForFileFact<{ pid: number; beats: number }>(
        paths.heartbeat,
        (text) => {
          if (!text) return undefined;
          const value = JSON.parse(text) as { pid: number; beats: number };
          return value.pid === heartbeatBefore.pid && value.beats > heartbeatAtVerification.beats
            ? value
            : undefined;
        },
      );
      await waitForFileFact(paths.trace, (text) =>
        traceRecords(text).filter((entry) => entry.textChunk === true).length >
        emissionsAtVerification
          ? true
          : undefined,
      );
      const persistedCharactersAfter = await waitForPersistedAssistantGrowth(
        paths.database,
        assistantCharacters,
        persistedCharactersBefore,
      );
      const processes = await ownedProcesses(input.mainPid);
      for (const owned of monitored)
        requireTrue(
          processes.some((entry) => entry.pid === owned.pid && entry.start === owned.start),
          "A Replay or terminal process restarted during renderer activation.",
        );
      const approvalAfter = await show(approval.threadId);
      const streamingAfter = await show(streaming.threadId);
      requireTrue(
        approvalAfter.thread.activeRunId === approvalBefore.thread.activeRunId &&
          approvalAfter.thread.pendingRequestCount > 0,
        "The pending approval was lost or relaunched.",
      );
      requireTrue(
        streamingAfter.thread.activeRunId === streaming.runId,
        "The streaming replay no longer has its original active run.",
      );
      const runs = readRows("orchestration_v2_projection_runs", "run_id, thread_id, status");
      const attempts = readRows(
        "orchestration_v2_projection_run_attempts",
        "attempt_id, run_id, status",
      );
      const requests = readRows(
        "orchestration_v2_projection_runtime_requests",
        "runtime_request_id, thread_id, status, resolved_at",
      );
      requireTrue(
        JSON.stringify(runs) === JSON.stringify(baseline.runs),
        "Run identity or status changed during activation.",
      );
      requireTrue(
        JSON.stringify(attempts) === JSON.stringify(baseline.attempts),
        "Provider run attempts changed during activation.",
      );
      requireTrue(
        JSON.stringify(requests) === JSON.stringify(baseline.requests),
        "Pending approval identity or status changed during activation.",
      );
      const events = database
        .prepare(
          "SELECT sequence, stream_id, event_type, payload_json FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id IN (?,?) AND sequence > ? ORDER BY sequence",
        )
        .all(...ids, high);
      requireTrue(
        events.some((event) => event.event_type === "message.updated"),
        "No fresh persisted message event was observed in the canonical fixture-thread event streams.",
      );
      requireTrue(
        !events.some((event) => {
          const payload = JSON.parse(String(event.payload_json)) as {
            status?: string;
            restartContinuationOfRunId?: string;
          };
          return (
            /cancel|interrupt|restart|resum/i.test(String(event.event_type)) ||
            payload.status === "cancelled" ||
            payload.status === "interrupted" ||
            Boolean(payload.restartContinuationOfRunId)
          );
        }),
        "The update cancelled, resumed or relaunched active work.",
      );
      await openThread(approval.threadId);
      await waitForApprovalControl();
      await openThread(HISTORICAL_THREAD);
      return {
        fixture: {
          provider: "official free Replay (dev)",
          streamingScenario: STREAM_MODEL,
          clock:
            "first chunk emitted; subsequent short timers released only after renderer activation",
        },
        approval: approvalAfter.thread,
        streaming: streamingAfter.thread,
        heartbeatBefore,
        heartbeatAtVerification,
        heartbeatAfter,
        emittedBefore,
        emissionsAtVerification,
        persistedAssistantCharacters: {
          before: persistedCharactersBefore,
          after: persistedCharactersAfter,
        },
        eventHighWaterBefore: Number(high),
        processIdentities: monitored.map(({ pid, start }) => ({ pid, start })),
        baseline,
        events: events.map((event) => event.event_type),
      };
    },
    async cleanup() {
      database.close();
      await openThread(streaming.threadId);
      const stopStream = page.getByRole("button", { name: "Stop generation", exact: true });
      if (await stopStream.count()) await stopStream.click();
      await page.getByRole("button", { name: "Toggle terminal drawer", exact: true }).click();
      const terminalInput = page.locator(
        'textarea[aria-label="Terminal input"][data-workspace-focus-default]',
      );
      await terminalInput.waitFor({ state: "attached" });
      await terminalInput.focus();
      await page.keyboard.press("Control+c");
      await page.keyboard.insertText(`printf reattached > ${quote(paths.reattachedShell)}`);
      await page.keyboard.press("Enter");
      await waitForFileFact(
        paths.reattachedShell,
        (text) => (text === "reattached" ? true : undefined),
        15_000,
      );
      const originalHeartbeat = monitored.find((entry) => entry.pid === heartbeatBefore.pid)!;
      const remaining = await NodeFSP.readFile(`/proc/${originalHeartbeat.pid}/stat`, "utf8").catch(
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
          throw error;
        },
      );
      const remainingStart = remaining
        ? remaining.slice(remaining.lastIndexOf(")") + 2).split(" ")[19]
        : undefined;
      requireTrue(
        remainingStart !== originalHeartbeat.start,
        "The reopened terminal did not interrupt the original Python process; it may have attached to a different PTY.",
      );
      await page.getByRole("button", { name: "Toggle terminal drawer", exact: true }).click();
      await openThread(approval.threadId);
      const stopApproval = page.getByRole("button", { name: "Stop generation", exact: true });
      if (await stopApproval.count()) await stopApproval.click();
      await openThread(HISTORICAL_THREAD);
      return {
        terminalReattached: true,
        shellSentinel: true,
        originalHeartbeatGone: true,
        heartbeatProcess: { pid: originalHeartbeat.pid, start: originalHeartbeat.start },
      };
    },
  };
}
