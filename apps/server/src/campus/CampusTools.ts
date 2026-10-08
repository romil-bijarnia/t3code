// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - the lane is a Promise-based MCP SDK client plus a detached broker process; both live outside the Effect runtime.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { laneDetail } from "./normalize.ts";

/**
 * The browser lane: the deakin-ontrack harness's two MCP servers (Deakin
 * portals, Microsoft web apps) driving one headless Chrome "broker" that
 * holds the signed-in sessions. This service owns spawning them and starting
 * the broker; it knows nothing about what the tools return.
 */

export type CampusLane = "deakin" | "microsoft";

export class CampusToolError extends Schema.TaggedError<CampusToolError>()("CampusToolError", {
  lane: Schema.Literals(["deakin", "microsoft"]),
  tool: Schema.String,
  category: Schema.Literals(["unavailable", "failed", "decode"]),
  /** The lane's own first line, bounded; it names a sign-in or broker problem in plain words. */
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `The ${this.lane} lane could not run ${this.tool} (${this.category}).`;
  }
}

export interface CampusLaneConfig {
  /** The harness component with `scripts/launch-*.sh` and the broker script. */
  readonly harnessDir: string;
  /** Where the harness keeps profiles, auth state and its own caches. */
  readonly dataDir: string;
  readonly keychainAccount: string | null;
  readonly brokerPort: number;
}

export class CampusTools extends Context.Service<
  CampusTools,
  {
    readonly call: (input: {
      readonly lane: CampusLane;
      readonly tool: string;
      readonly args: Record<string, unknown>;
      readonly timeoutMs?: number;
    }) => Effect.Effect<unknown, CampusToolError>;
    /** Whether the broker answers on its port right now. */
    readonly laneOnline: Effect.Effect<boolean>;
    /** Starts the headless broker when it is down; resolves to whether it answers afterwards. */
    readonly ensureLane: Effect.Effect<boolean>;
    /** A file under the lane's data directory, or null when it is not there. */
    readonly readLaneFile: (relativePath: string) => Effect.Effect<string | null>;
  }
>()("t3/campus/CampusTools") {}

const DEFAULT_TOOL_TIMEOUT_MS = 90_000;
/** Tool answers are free-form JSON text; anything else comes back as the text itself. */
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const BROKER_START_WAIT_MS = 20_000;

const LAUNCH_SCRIPTS: Record<CampusLane, string> = {
  deakin: "launch-deakin-ontrack.sh",
  microsoft: "launch-microsoft-local.sh",
};

/** Mirrors the harness launch scripts' own search for a Node runtime. */
const NODE_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
  "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

const isExecutable = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The account the harness was registered with, so the fork needs no copy of it. */
function keychainAccountFromClaudeConfig(home: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, ".claude.json"), "utf8"),
    );
    const servers =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { mcpServers?: Record<string, { env?: Record<string, string> }> }).mcpServers
        : undefined;
    const account = servers?.["deakin-ontrack"]?.env?.MICROSOFT_KEYCHAIN_ACCOUNT;
    return typeof account === "string" && account.trim() !== "" ? account : null;
  } catch {
    return null;
  }
}

export function resolveCampusLaneConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = NodeOS.homedir(),
): CampusLaneConfig {
  const harnessDir =
    env.T3_CAMPUS_HARNESS_DIR?.trim() ||
    NodePath.join(home, ".local/share/sara-harness/current/components/deakin-ontrack");
  const dataDir =
    env.DEAKIN_ONTRACK_DATA_DIR?.trim() ||
    NodePath.join(home, ".codex/plugins/state/deakin-ontrack");
  const keychainAccount =
    env.MICROSOFT_KEYCHAIN_ACCOUNT?.trim() || keychainAccountFromClaudeConfig(home);
  const port = Number(env.MICROSOFT_BROWSER_BROKER_PORT);
  return {
    harnessDir,
    dataDir,
    keychainAccount,
    brokerPort: Number.isInteger(port) && port > 0 ? port : 9223,
  };
}

function laneEnvironment(config: CampusLaneConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MICROSOFT_BROWSER_BROKER: "required",
    MICROSOFT_BROWSER_BROKER_PORT: String(config.brokerPort),
    MISSION_CONTROL_NO_WINDOW: "1",
    MICROSOFT_MFA_METHOD: process.env.MICROSOFT_MFA_METHOD ?? "passkey",
    DEAKIN_ONTRACK_DATA_DIR: config.dataDir,
    ...(config.keychainAccount ? { MICROSOFT_KEYCHAIN_ACCOUNT: config.keychainAccount } : {}),
  };
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function nodeRuntime(env: NodeJS.ProcessEnv): { command: string; env: NodeJS.ProcessEnv } {
  const configured = env.SARA_HARNESS_NODE?.trim();
  const found = [configured, ...NODE_CANDIDATES].find(
    (candidate): candidate is string => typeof candidate === "string" && isExecutable(candidate),
  );
  // The server itself may run inside Electron; its binary doubles as Node with the flag.
  return found
    ? { command: found, env }
    : { command: process.execPath, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}

async function startBroker(config: CampusLaneConfig): Promise<boolean> {
  const env = laneEnvironment(config);
  const runtime = nodeRuntime(env);
  const child = NodeChildProcess.spawn(
    runtime.command,
    [NodePath.join(config.harnessDir, "scripts/microsoft-browser-broker.mjs"), "start"],
    { cwd: config.harnessDir, env: runtime.env, detached: true, stdio: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + BROKER_START_WAIT_MS;
  while (Date.now() < deadline) {
    if (await probePort(config.brokerPort)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return probePort(config.brokerPort);
}

class LaneToolFailure extends Error {
  readonly text: string;
  constructor(text: string) {
    super(text);
    this.text = text;
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        ? [String((part as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
}

const make = Effect.gen(function* () {
  const config = resolveCampusLaneConfig();
  const clients = new Map<CampusLane, Promise<Client>>();
  // One call at a time per lane: each lane drives shared browser tabs.
  const permits: Record<CampusLane, Semaphore.Semaphore> = {
    deakin: yield* Semaphore.make(1),
    microsoft: yield* Semaphore.make(1),
  };

  const connect = (lane: CampusLane): Promise<Client> => {
    const existing = clients.get(lane);
    if (existing) return existing;
    const pending = (async () => {
      const transport = new StdioClientTransport({
        command: "/bin/bash",
        args: [NodePath.join(config.harnessDir, "scripts", LAUNCH_SCRIPTS[lane])],
        env: laneEnvironment(config) as Record<string, string>,
        cwd: config.harnessDir,
        stderr: "ignore",
      });
      const client = new Client({ name: "t3code-campus", version: "1" });
      client.onclose = () => {
        if (clients.get(lane) === pending) clients.delete(lane);
      };
      try {
        await client.connect(transport);
      } catch (error) {
        clients.delete(lane);
        throw error;
      }
      return client;
    })();
    clients.set(lane, pending);
    return pending;
  };

  const call: CampusTools["Service"]["call"] = ({ lane, tool, args, timeoutMs }) =>
    permits[lane].withPermits(1)(
      Effect.tryPromise({
        try: async () => {
          const client = await connect(lane);
          const result = await client.callTool({ name: tool, arguments: args }, undefined, {
            timeout: timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
          });
          const text = textOf(result.content);
          if (result.isError) throw new LaneToolFailure(text);
          if (result.structuredContent !== undefined) return result.structuredContent;
          try {
            return decodeJsonText(text);
          } catch {
            return text;
          }
        },
        catch: (cause) =>
          cause instanceof LaneToolFailure
            ? new CampusToolError({
                lane,
                tool,
                category: "failed",
                detail: laneDetail(cause.text),
              })
            : new CampusToolError({
                lane,
                tool,
                category: "unavailable",
                detail: laneDetail(cause instanceof Error ? cause.message : String(cause)),
                cause,
              }),
      }),
    );

  const readLaneFile = (relativePath: string) =>
    Effect.promise(() =>
      NodeFS.promises
        .readFile(NodePath.join(config.dataDir, relativePath), "utf8")
        .then((text): string | null => text)
        .catch((): string | null => null),
    );
  const laneOnline = Effect.promise(() => probePort(config.brokerPort));
  const ensureLane = Effect.promise(async () =>
    (await probePort(config.brokerPort)) ? true : startBroker(config),
  );

  return CampusTools.of({ call, laneOnline, ensureLane, readLaneFile });
});

export const layer = Layer.effect(CampusTools, make);
