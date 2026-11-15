// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off - Isolated Electron verification uses bounded native recovery deadlines outside Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, type CDPSession, type ElectronApplication, type Page } from "playwright-core";

import type { DesktopBridge, DesktopLiveClientUpdateState } from "@t3tools/contracts";
import {
  inspectLiveClientBundle,
  type LiveClientManifest,
} from "../apps/desktop/src/updates/liveClientManifest.ts";
import { buildLiveClientUpdate } from "./build-live-client-update.ts";
import { createLiveClientRuntimeId } from "./live-client-runtime-id.ts";
import {
  seedLiveClientSmokeWork,
  prepareLiveClientSmokeWork,
} from "./lib/live-client-smoke-work.ts";

type SmokeWindow = Window & {
  desktopBridge?: DesktopBridge;
  __liveClientSmokeFile?: File | undefined;
  __liveClientSmokeState?: DesktopLiveClientUpdateState;
};

const STEP_TIMEOUT_MS = 90_000;
const THREAD_TITLE = "Release launch check";
const THREAD_MESSAGE = "The release opens and shows this thread.";
const DRAFT = "Unsent live-update smoke draft";
const FILE_NAME = "live-update-unsent.txt";
const FILE_CONTENT = "Unsent file bytes must survive a deferred update.\n";
// oxlint-disable-next-line t3code/no-global-process-runtime -- The standalone CLI inspects the actual host process tree before creating an Effect runtime.
const isLinux = process.platform === "linux";
const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    app: { type: "string" },
    "candidate-client": { type: "string" },
    "artifacts-dir": { type: "string" },
    "active-work": { type: "boolean", default: false },
    background: { type: "boolean", default: false },
    fault: { type: "string" },
  },
});
if (!values.executable || !values.app || !values["candidate-client"] || !values["artifacts-dir"]) {
  throw new Error(
    "Usage: smoke-live-client-update.ts --executable <electron> --app <desktop app> --candidate-client <built web directory> --artifacts-dir <external directory>",
  );
}
const fault = values.fault;
if (fault !== undefined && !["signature", "missing-entry", "crash"].includes(fault)) {
  throw new Error("--fault must be signature, missing-entry or crash.");
}
if (fault && values["active-work"])
  throw new Error("Fault scenarios cannot be combined with --active-work.");
const executable = NodePath.resolve(values.executable);
const appDirectory = NodePath.resolve(values.app);
const candidateClient = NodePath.resolve(values["candidate-client"]);
const artifactsDir = NodePath.resolve(values["artifacts-dir"]);
if (artifactsDir === repoRoot || artifactsDir.startsWith(repoRoot + NodePath.sep)) {
  throw new Error("Smoke artifacts must stay outside the source repository.");
}
await NodeFSP.mkdir(artifactsDir, { recursive: true });
const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-live-client-smoke-"));
const t3Home = NodePath.join(home, "t3");
const result: Record<string, unknown> = { passed: false, artifactsDir, fault: fault ?? null };
const errors: string[] = [];
const navigation: string[] = [];
const failedAssets: { url: string; error: string | null }[] = [];
let step = "preparing isolated update fixtures";
let app: ElectronApplication | undefined;
let page: Page | undefined;
let server: NodeHttp.Server | undefined;
let work: Awaited<ReturnType<typeof prepareLiveClientSmokeWork>> | undefined;
let backgroundWindow: { mainId: number; id: number } | undefined;
let focusSession: CDPSession | undefined;

function requireTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clientVersion(html: string): string {
  const tag = html.match(/<meta\b[^>]*name=["']t3-live-client-version["'][^>]*>/i)?.[0];
  const version = tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
  if (!version) throw new Error("Built client has no live-update version metadata.");
  return version;
}

async function ownedBackendPids(rootPid: number): Promise<number[]> {
  if (!isLinux) return [];
  const queue = [rootPid];
  const backends: number[] = [];
  const seen = new Set<number>();
  for (const pid of queue) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const command = await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (pid !== rootPid && command.includes("apps/server/dist/bin.mjs")) backends.push(pid);
    const children = await NodeFSP.readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(
      () => "",
    );
    for (const child of children.trim().split(/\s+/)) {
      const id = Number(child);
      if (Number.isSafeInteger(id) && id > 0) queue.push(id);
    }
  }
  return backends.sort((a, b) => a - b);
}

function observeFaultRecovery(
  application: ElectronApplication,
  contentsId: number,
  candidate: string,
  baseline: string,
  crash: boolean,
) {
  return application.evaluate(
    ({ webContents }, input) => {
      const contents = webContents.fromId(input.contentsId);
      if (!contents) throw new Error("Owned smoke window disappeared.");
      return new Promise<{
        trialUrl: string;
        nativeCrash: boolean;
        loadedVersion: string;
        state: DesktopLiveClientUpdateState;
        interactive: boolean;
        screenshotBase64: string;
      }>((resolve, reject) => {
        let trialUrl = "";
        let nativeCrash = false;
        let checkingBaseline = false;
        const cleanup = () => {
          clearTimeout(deadline);
          contents.removeListener("did-finish-load", loaded);
          contents.removeListener("render-process-gone", gone);
        };
        const failed = (error: unknown) => {
          cleanup();
          reject(error);
        };
        const gone = () => {
          nativeCrash = true;
        };
        const loaded = () => {
          const url = new URL(contents.getURL());
          if (url.searchParams.get("__t3_live_client_trial") === input.candidate) {
            trialUrl = url.toString();
            if (input.crash && !nativeCrash) contents.forcefullyCrashRenderer();
            return;
          }
          if (!trialUrl || checkingBaseline || url.searchParams.has("__t3_live_client_trial"))
            return;
          checkingBaseline = true;
          void (async () => {
            const version = JSON.stringify(input.baseline);
            await contents.executeJavaScript(`new Promise((resolve) => {
            const ready = () => document.querySelector('meta[name="t3-live-client-version"]')?.content === ${version}
              && !new URL(location.href).searchParams.has('__t3_live_client_trial')
              && document.getElementById('root')?.textContent?.includes(${JSON.stringify(input.threadMessage)})
              && !document.body.inert && !document.getElementById('root')?.inert;
            if (ready()) { resolve(true); return; }
            const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); resolve(true); } });
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          })`);
            const snapshot = (await contents.executeJavaScript(`(async () => ({
            loadedVersion: document.querySelector('meta[name="t3-live-client-version"]')?.content,
            state: await window.desktopBridge.liveClientUpdates.getState(),
            interactive: !document.body.inert && !document.getElementById('root')?.inert
          }))()`)) as {
              loadedVersion: string;
              state: DesktopLiveClientUpdateState;
              interactive: boolean;
            };
            const screenshotBase64 = (await contents.capturePage()).toPNG().toString("base64");
            cleanup();
            resolve({ ...snapshot, trialUrl, nativeCrash, screenshotBase64 });
          })().catch(failed);
        };
        const deadline = setTimeout(
          () => failed(new Error("Native trial rollback did not restore the baseline window.")),
          input.timeout,
        );
        contents.on("did-finish-load", loaded);
        contents.on("render-process-gone", gone);
      });
    },
    {
      contentsId,
      candidate,
      baseline,
      crash,
      timeout: STEP_TIMEOUT_MS,
      threadMessage: THREAD_MESSAGE,
    },
  );
}

try {
  requireTrue(
    !(values.background && values.fault),
    "Background mode is a positive handover test, not a fault fixture.",
  );
  requireTrue(
    isLinux,
    "This isolated desktop smoke harness currently requires Linux/XDG isolation.",
  );
  const baselineRoot = NodePath.join(repoRoot, "apps/server/dist/client");
  const desktopPackage = JSON.parse(
    await NodeFSP.readFile(NodePath.join(appDirectory, "package.json"), "utf8"),
  ) as { version: string };
  const baselineVersion = clientVersion(
    await NodeFSP.readFile(NodePath.join(baselineRoot, "index.html"), "utf8"),
  );
  requireTrue(
    baselineVersion === desktopPackage.version,
    "Baseline renderer must match the desktop package version.",
  );
  const candidateVersion = clientVersion(
    await NodeFSP.readFile(NodePath.join(candidateClient, "index.html"), "utf8"),
  );
  requireTrue(
    candidateVersion !== baselineVersion,
    "Candidate renderer needs a different release version.",
  );
  const runtimeId = await createLiveClientRuntimeId(repoRoot);
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const baseline: LiveClientManifest = {
    format: 1,
    version: baselineVersion,
    channel: "stable",
    runtimeId,
    files: await inspectLiveClientBundle(baselineRoot),
  };
  const payload = JSON.stringify(baseline);
  const baselineEnvelope = {
    manifest: payload,
    signature: NodeCrypto.sign(null, Buffer.from(payload), privateKey).toString("base64"),
  };
  const feedDirectory = NodePath.join(home, "feed");
  let candidateEnvelope = await buildLiveClientUpdate({
    clientDir: candidateClient,
    outputDir: feedDirectory,
    version: candidateVersion,
    channel: "stable",
    runtimeId,
    privateKeyPem,
  });
  if (fault === "signature") {
    const signature = candidateEnvelope.signature;
    candidateEnvelope = {
      ...candidateEnvelope,
      signature: (signature[0] === "A" ? "B" : "A") + signature.slice(1),
    };
  } else if (fault === "missing-entry" || fault === "crash") {
    const entry = NodePath.join(feedDirectory, "client/index.html");
    const html = await NodeFSP.readFile(entry, "utf8");
    let replaced = 0;
    const broken = html.replace(
      /<script\b(?=[^>]*\btype=["']module["'])[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
      (tag: string) => {
        replaced += 1;
        return tag.replace(
          /\bsrc=["'][^"']+["']/i,
          'src="/assets/live-client-smoke-missing-entry.js"',
        );
      },
    );
    requireTrue(replaced === 1, "Fault fixture needs exactly one module entry script.");
    await NodeFSP.writeFile(entry, broken);
    const modified: LiveClientManifest = {
      ...(JSON.parse(candidateEnvelope.manifest) as LiveClientManifest),
      files: await inspectLiveClientBundle(NodePath.join(feedDirectory, "client")),
    };
    const manifest = JSON.stringify(modified);
    candidateEnvelope = {
      manifest,
      signature: NodeCrypto.sign(null, Buffer.from(manifest), privateKey).toString("base64"),
    };
  }
  let published = false;
  const requests: string[] = [];
  server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1/").pathname;
      requests.push(pathname);
      response.setHeader("cache-control", "no-store");
      if (pathname === "/manifest.json") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(published ? candidateEnvelope : baselineEnvelope));
        return;
      }
      const relative = decodeURIComponent(pathname).slice(1);
      const root = published ? feedDirectory : NodePath.dirname(baselineRoot);
      const file = NodePath.resolve(root, relative);
      if (!relative.startsWith("client/") || !file.startsWith(root + NodePath.sep)) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await NodeFSP.readFile(file);
      response.end(bytes);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  requireTrue(address && typeof address === "object", "Loopback feed did not bind a TCP port.");
  const configuration = NodePath.join(home, "host.json");
  await NodeFSP.writeFile(
    configuration,
    JSON.stringify({
      publicKey: publicKeyPem,
      feedUrl: `http://127.0.0.1:${address.port}/`,
      baseline: baselineEnvelope,
    }),
    { mode: 0o600 },
  );
  await NodeFSP.mkdir(NodePath.join(t3Home, "userdata"), { recursive: true });
  await NodeFSP.copyFile(
    NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite"),
    NodePath.join(t3Home, "userdata/statev2.sqlite"),
  );
  if (values["active-work"]) await seedLiveClientSmokeWork({ repoRoot, t3Home, home });
  const env = { ...process.env };
  delete env.VITE_DEV_SERVER_URL;
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  delete env.T3CODE_PORT;
  step = "launching the isolated production-mode desktop client";
  app = await _electron.launch({
    executablePath: executable,
    args: [appDirectory, "--no-sandbox", "--password-store=basic", "--force-device-scale-factor=1"],
    env: {
      ...env,
      XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      XDG_DATA_HOME: NodePath.join(home, ".local/share"),
      XDG_CACHE_HOME: NodePath.join(home, ".cache"),
      XDG_SESSION_TYPE: "x11",
      T3CODE_HOME: t3Home,
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "false",
      T3CODE_EXPERIMENTAL_LIVE_CLIENT_CONFIG: configuration,
    },
    timeout: STEP_TIMEOUT_MS,
  });
  const mainPid = app.process().pid;
  requireTrue(mainPid, "Electron process has no PID.");
  page = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  if (values.background) {
    // Playwright forces foreground focus by default; this case must observe real native focus.
    focusSession = await page.context().newCDPSession(page);
    await focusSession.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  }
  result.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
  }));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("framenavigated", (frame) => {
    if (frame === page!.mainFrame()) navigation.push(frame.url());
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("t3code://app/"))
      failedAssets.push({ url: request.url(), error: request.failure()?.errorText ?? null });
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().startsWith("t3code://app/"))
      failedAssets.push({ url: response.url(), error: `HTTP ${response.status()}` });
  });
  step = "opening the seeded thread";
  const thread = page.locator("li[data-thread-item]", { hasText: THREAD_TITLE });
  await thread.waitFor({ state: "attached" });
  if (!(await thread.isVisible())) await page.locator('[data-sidebar="trigger"]').first().click();
  await thread.waitFor();
  await thread.click();
  await page.getByText(THREAD_MESSAGE).waitFor();
  await page.evaluate(async () => {
    const bridge = (window as SmokeWindow).desktopBridge!.liveClientUpdates!;
    bridge.onState((state) => {
      (window as SmokeWindow).__liveClientSmokeState = state;
    });
    (window as SmokeWindow).__liveClientSmokeState = await bridge.getState();
  });
  await page.waitForFunction(
    () => (window as SmokeWindow).__liveClientSmokeState?.phase === "idle",
  );
  const backendBefore = await ownedBackendPids(mainPid);
  requireTrue(!isLinux || backendBefore.length > 0, "No owned backend child was identified.");
  result.versions = { baseline: baselineVersion, candidate: candidateVersion, runtimeId };
  result.before = { mainPid, backendPids: backendBefore };
  if (values["active-work"]) {
    step = "starting free Replay turns, a pending approval and an actual terminal command";
    work = await prepareLiveClientSmokeWork({ page, repoRoot, t3Home, home, mainPid });
  }

  step = "holding a genuine unsent composer draft and File attachment";
  if (values.background) {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().startsWith("t3code://app/"))
        ?.focus();
    });
    await page.waitForFunction(() => document.hasFocus());
  }
  const composer = page.getByTestId("composer-editor").first();
  await composer.fill(DRAFT);
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.evaluate((input) => {
    input.addEventListener(
      "change",
      () => {
        (window as SmokeWindow).__liveClientSmokeFile = (input as HTMLInputElement).files?.[0];
      },
      { capture: true, once: true },
    );
  });
  await fileInput.setInputFiles({
    name: FILE_NAME,
    mimeType: "text/plain",
    buffer: Buffer.from(FILE_CONTENT),
  });
  await page.getByText(FILE_NAME, { exact: true }).first().waitFor();
  const offeredAt = performance.now();
  published = true;
  await page.evaluate(() => (window as SmokeWindow).desktopBridge!.checkForUpdate());
  const prepared = await page.evaluate(() =>
    (window as SmokeWindow).desktopBridge!.liveClientUpdates!.getState(),
  );
  requireTrue(
    fault === "signature"
      ? prepared.phase === "deferred"
      : prepared.phase === "ready" && prepared.candidateVersion === candidateVersion,
    `Candidate was not prepared: ${prepared.phase} (${prepared.reason ?? "no reason"}).`,
  );
  result.downloadAndValidationMs = performance.now() - offeredAt;
  const deferred = await page.evaluate(async () => ({
    state: await (window as SmokeWindow).desktopBridge!.liveClientUpdates!.getState(),
    loadedVersion: document.querySelector<HTMLMetaElement>('meta[name="t3-live-client-version"]')
      ?.content,
    fileBytes: await (window as SmokeWindow).__liveClientSmokeFile?.text(),
    composerText: document.querySelector('[data-testid="composer-editor"]')?.textContent,
  }));
  requireTrue(
    deferred.state.currentVersion === baselineVersion && deferred.loadedVersion === baselineVersion,
    "Unsafe draft did not defer the candidate.",
  );
  requireTrue(
    deferred.fileBytes === FILE_CONTENT && deferred.composerText?.includes(DRAFT),
    "The pending draft or File bytes changed.",
  );
  result.deferred = deferred;
  await page.screenshot({ path: NodePath.join(artifactsDir, "draft-defers-update.png") });

  if (fault === "signature") {
    step = "verifying signature refusal leaves the original page and processes untouched";
    requireTrue(
      !navigation.some((url) => new URL(url).searchParams.has("__t3_live_client_trial")),
      "Invalid signature navigated to a candidate trial.",
    );
    requireTrue(
      prepared.currentVersion === baselineVersion && deferred.state.phase === "deferred",
      "Invalid signature changed the active release.",
    );
    requireTrue(
      app.process().pid === mainPid &&
        JSON.stringify(await ownedBackendPids(mainPid)) === JSON.stringify(backendBefore),
      "Signature refusal changed process identities.",
    );
    const interactive = await page.evaluate(
      () => !document.body.inert && !document.getElementById("root")?.inert,
    );
    requireTrue(interactive, "Signature refusal left the old page noninteractive.");
    requireTrue(
      requests.every((name) => name === "/manifest.json"),
      "Invalid signature caused asset downloads.",
    );
    result.after = {
      ...deferred,
      mainPid,
      backendPids: await ownedBackendPids(mainPid),
      interactive,
    };
    result.observedTrialNavigation = false;
    result.requests = requests;
    result.passed = true;
    console.log(
      "Live client signature fault passed: candidate refused without changing the interactive page or process identities.",
    );
  } else {
    const windowHandle = await app.browserWindow(page);
    const contentsId = await windowHandle.evaluate((window) => window.webContents.id);
    await windowHandle.dispose();
    const recovery = fault
      ? observeFaultRecovery(app, contentsId, candidateVersion, baselineVersion, fault === "crash")
      : null;
    void recovery?.catch(() => undefined);
    step = "clearing unsent state and observing automatic renderer activation";
    const activationAt = performance.now();
    await composer.press("ControlOrMeta+a");
    await composer.press("Backspace");
    await page.getByText(FILE_NAME, { exact: true }).waitFor({ state: "hidden" });
    try {
      await page.evaluate((background) => {
        if (!background) (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.removeAllRanges();
        delete (window as SmokeWindow).__liveClientSmokeFile;
        window.dispatchEvent(new Event("change"));
      }, Boolean(values.background));
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          /Execution context was destroyed|Cannot find context/.test(error.message)
        )
      )
        throw error;
      result.navigationDuringRelease = true;
    }
    if (values.background) {
      const before = await page.evaluate(() => ({
        active: document.activeElement?.getAttribute("data-testid"),
        empty: document.activeElement?.textContent === "",
        focused: document.hasFocus(),
      }));
      requireTrue(
        before.active === "composer-editor" && before.empty && before.focused,
        "Background fixture did not retain an empty foreground composer before switching windows.",
      );
      backgroundWindow = await app.evaluate(async ({ app, BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith("t3code://app/"),
        );
        if (!main) throw new Error("The owned app window is missing.");
        const other = new BrowserWindow({
          width: 250,
          height: 140,
          x: 1150,
          y: 820,
          show: false,
          webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
        });
        (app as unknown as Record<string, unknown>).__liveClientSmokeBackgroundWindow = other;
        await other.loadURL(
          "data:text/html,<title>Background work fixture</title><p>Working in another window.</p>",
        );
        other.show();
        main.blur();
        other.focus();
        return { mainId: main.id, id: other.id };
      });
      result.backgroundBefore = before;
    }
    if (recovery) {
      step = "observing actual trial navigation and native baseline recovery";
      const { screenshotBase64, ...recovered } = await recovery;
      await NodeFSP.writeFile(
        NodePath.join(artifactsDir, `fault-${fault}-recovered.png`),
        Buffer.from(screenshotBase64, "base64"),
      );
      requireTrue(
        recovered.trialUrl.includes("__t3_live_client_trial="),
        "Fault never navigated to the candidate trial.",
      );
      requireTrue(
        recovered.loadedVersion === baselineVersion &&
          recovered.interactive &&
          recovered.state.phase === "deferred" &&
          recovered.state.currentVersion === baselineVersion,
        "Failed trial did not restore the old interactive release.",
      );
      if (fault === "crash")
        requireTrue(recovered.nativeCrash, "Requested native renderer crash was not observed.");
      step = "checking failed candidate is not retried";
      const beforeRecheck = requests.length;
      const rechecked = (await app.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id);
        if (!contents) throw new Error("Owned smoke window disappeared.");
        return await contents.executeJavaScript(`new Promise((resolve, reject) => {
        const live = window.desktopBridge.liveClientUpdates;
        let checking = false;
        const deadline = setTimeout(() => { off(); reject(new Error('Failed version recheck did not finish.')); }, 30000);
        const off = live.onState((state) => {
          if (state.phase === 'checking') checking = true;
          if (checking && state.phase === 'deferred') { clearTimeout(deadline); off(); resolve(state); }
        });
        window.desktopBridge.checkForUpdate().catch((error) => { clearTimeout(deadline); off(); reject(error); });
      })`);
      }, contentsId)) as DesktopLiveClientUpdateState;
      const recheckRequests = requests.slice(beforeRecheck);
      requireTrue(
        rechecked.reason === "previous-activation-failed",
        "Failed trial was not retained in the automatic-retry refusal set.",
      );
      requireTrue(
        recheckRequests.length === 1 && recheckRequests[0] === "/manifest.json",
        "Failed candidate recheck downloaded assets again.",
      );
      const backendAfter = await ownedBackendPids(mainPid);

      requireTrue(
        app.process().pid === mainPid &&
          JSON.stringify(backendAfter) === JSON.stringify(backendBefore),
        "Fault recovery changed main/backend process identities.",
      );
      result.after = { ...recovered, mainPid, backendPids: backendAfter };
      result.observedTrialNavigation = true;
      result.expectedFault = {
        missingAsset: "t3code://app/assets/live-client-smoke-missing-entry.js",
        nativeCrash: fault === "crash",
      };
      result.recheck = { state: rechecked, requests: recheckRequests };
      result.requests = requests;
      result.passed = true;
      console.log(
        `Live client ${fault} fault passed: actual trial rolled back to the old interactive renderer without restarting Electron or its backend.`,
      );
    } else {
      await page.waitForFunction(
        (version) => {
          return (
            document.querySelector<HTMLMetaElement>('meta[name="t3-live-client-version"]')
              ?.content === version &&
            !new URL(window.location.href).searchParams.has("__t3_live_client_trial") &&
            Boolean(document.getElementById("root")?.hasChildNodes()) &&
            !document.body?.inert &&
            !document.getElementById("root")?.inert
          );
        },
        candidateVersion,
        { timeout: STEP_TIMEOUT_MS },
      );
      await page.getByText(THREAD_MESSAGE).waitFor();
      result.activationMs = performance.now() - activationAt;
      const after = await page.evaluate(async () => ({
        state: await (window as SmokeWindow).desktopBridge!.liveClientUpdates!.getState(),
        loadedVersion: document.querySelector<HTMLMetaElement>(
          'meta[name="t3-live-client-version"]',
        )?.content,
        trial: new URL(window.location.href).searchParams.get("__t3_live_client_trial"),
        inert: document.body.inert || Boolean(document.getElementById("root")?.inert),
      }));
      const backendAfter = await ownedBackendPids(mainPid);
      if (backgroundWindow) {
        const focus = await app.evaluate(
          ({ BrowserWindow }, ids) => ({
            mainFocused: BrowserWindow.fromId(ids.mainId)?.isFocused(),
            otherFocused: BrowserWindow.fromId(ids.id)?.isFocused(),
          }),
          backgroundWindow,
        );
        result.backgroundAfter = focus;
        requireTrue(
          focus.mainFocused === false && focus.otherFocused === true,
          "The live update stole focus from the other window.",
        );
        await app.evaluate(({ app, BrowserWindow }, ids) => {
          BrowserWindow.fromId(ids.id)?.destroy();
          delete (app as unknown as Record<string, unknown>).__liveClientSmokeBackgroundWindow;
          BrowserWindow.fromId(ids.mainId)?.focus();
          BrowserWindow.fromId(ids.mainId)?.webContents.focus();
        }, backgroundWindow);
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("data-testid") === "composer-editor",
        );
        result.backgroundFocusRestored = true;
      }
      result.after = { ...after, mainPid, backendPids: backendAfter };
      if (work) result.continuity = await work.verify();
      requireTrue(
        app.process().pid === mainPid,
        "Electron restarted during the live client update.",
      );
      requireTrue(
        JSON.stringify(backendAfter) === JSON.stringify(backendBefore),
        "Backend process identities changed.",
      );
      requireTrue(
        after.loadedVersion === candidateVersion &&
          after.state.phase === "applied" &&
          after.state.currentVersion === candidateVersion &&
          !after.trial &&
          !after.inert,
        "The new renderer did not finish healthy activation.",
      );
      requireTrue(errors.length === 0, `Renderer errors: ${errors.join("; ")}`);
      result.after = { ...after, mainPid, backendPids: backendAfter };
      result.requests = requests;
      result.passed = true;
      await page.screenshot({ path: NodePath.join(artifactsDir, "live-update-applied.png") });
      if (work) result.cleanup = await work.cleanup();
      console.log(
        "Live client smoke check passed: draft deferred the candidate; renderer activated without restarting Electron or its backend.",
      );
    }
  }
} catch (error) {
  result.passed = false;
  result.failedStep = step;
  result.error = error instanceof Error ? error.message : String(error);
  if (page)
    result.failureState = await page
      .evaluate(async () => ({
        state: await (window as SmokeWindow).desktopBridge?.liveClientUpdates?.getState(),
        version: document.querySelector<HTMLMetaElement>('meta[name="t3-live-client-version"]')
          ?.content,
        trial: new URL(window.location.href).searchParams.get("__t3_live_client_trial"),
        inert: document.body.inert,
        deferral: document.documentElement.dataset.liveClientDeferred,
        documentFocused: document.hasFocus(),
        focused: {
          tag: document.activeElement?.tagName,
          role: document.activeElement?.getAttribute("role"),
          testId: document.activeElement?.getAttribute("data-testid"),
        },
        selectionLength: document.getSelection()?.toString().length,
        dialogs: document.querySelectorAll(
          'dialog[open], [role="dialog"]:not([hidden]):not([aria-hidden="true"]):not([data-state="closed"]), [role="alertdialog"], [role="menu"], .monaco-editor, .cm-editor',
        ).length,
        editables: Array.from(document.querySelectorAll('[contenteditable="true"]')).map(
          (node) => ({
            testId: node.getAttribute("data-testid"),
            length: node.textContent?.length,
            codes: Array.from((node.textContent ?? "").slice(0, 5)).map((c) => c.codePointAt(0)),
          }),
        ),
        inputs: Array.from(document.querySelectorAll("input,textarea")).map((node) => ({
          tag: node.tagName,
          type: (node as HTMLInputElement).type,
          length: (node as HTMLInputElement).value.length,
        })),
      }))
      .catch(() => null);
  console.error(`Live client smoke check failed while ${step}: ${String(result.error)}`);
  if (page)
    await page
      .screenshot({ path: NodePath.join(artifactsDir, "failure.png"), timeout: 10_000 })
      .catch(() => {});
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs))
    await NodeFSP.cp(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
  process.exitCode = 1;
} finally {
  result.pageErrors = errors;
  result.navigation = navigation;
  result.failedAssets = failedAssets;
  if (values["active-work"]) {
    for (const file of ["replay-emissions.ndjson", "heartbeat.json", "slow-replay.mjs"]) {
      await NodeFSP.copyFile(NodePath.join(home, file), NodePath.join(artifactsDir, file)).catch(
        () => {},
      );
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(artifactsDir, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  if (app) {
    const child = app.process();
    const closed = app.close().catch(() => {});
    await Promise.race([closed, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    child.kill("SIGKILL");
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await NodeFSP.rm(home, { recursive: true, force: true, maxRetries: 5 });
}
