import type { DesktopLiveClientUpdateState } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import { hasPendingDesktopClientWork, subscribeDesktopClientIdle } from "../ipc/liveClientWork.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import { verifyManifest } from "./liveClientManifest.ts";
import { createLiveClientUpdater } from "./liveClientUpdater.ts";
import { prepareLiveClientCache } from "./liveClientCache.ts";
import { retainLiveClientTrial } from "./liveClientTrial.ts";

class LiveClientOperationError extends Schema.TaggedError<LiveClientOperationError>()(
  "LiveClientOperationError",
  { operation: Schema.Literals(["cache", "rollback-probe"]), cause: Schema.Defect() },
) {}

export class DesktopLiveClientUpdates extends Context.Service<
  DesktopLiveClientUpdates,
  {
    readonly configure: Effect.Effect<boolean, never, Scope.Scope>;
    readonly check: Effect.Effect<void>;
    readonly resolveAsset: (relativePath: string) => string | undefined;
    readonly getState: Effect.Effect<DesktopLiveClientUpdateState>;
    readonly activate: (version: string) => Effect.Effect<boolean>;
    readonly acknowledge: (version: string) => Effect.Effect<boolean>;
    readonly fail: (version: string, reload: boolean) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/updates/DesktopLiveClientUpdates") {}

const decodeHost = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const config = yield* DesktopConfig.DesktopConfig;
  const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;
  const windows = yield* ElectronWindow.ElectronWindow;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const fileSystem = yield* FileSystem.FileSystem;
  const events = yield* Queue.unbounded<DesktopLiveClientUpdateState | { rollback: string }>();
  let updater: ReturnType<typeof createLiveClientUpdater> | undefined;
  let channelMatches = true;
  let configured = false;
  let trialWindow: {
    contents: Electron.WebContents;
    crashed: boolean;
    onCrash: () => void;
    onDestroyed: () => void;
    onLoaded: (() => void) | null;
    release: () => void;
  } | null = null;
  const clearTrialWindow = () => {
    if (trialWindow) {
      trialWindow.contents.removeListener("render-process-gone", trialWindow.onCrash);
      trialWindow.contents.removeListener("destroyed", trialWindow.onDestroyed);
      if (trialWindow.onLoaded)
        trialWindow.contents.removeListener("did-finish-load", trialWindow.onLoaded);
      trialWindow.release();
    }
    trialWindow = null;
  };
  const reloadTrialWindow = (contents: Electron.WebContents) => {
    const record = trialWindow;
    if (record?.contents.id === contents.id) {
      record.contents.removeListener("render-process-gone", record.onCrash);
      record.onLoaded = () => {
        if (trialWindow === record) clearTrialWindow();
      };
      record.contents.once("did-finish-load", record.onLoaded);
    }
    contents.reloadIgnoringCache();
  };
  let disabled: DesktopLiveClientUpdateState = {
    phase: "disabled",
    currentVersion: environment.appVersion,
    candidateVersion: null,
    reason: "experimental-live-client-feed-not-configured",
  };

  const configure = Effect.gen(function* () {
    if (configured) return updater !== undefined;
    configured = true;
    const location = yield* Config.String("T3CODE_EXPERIMENTAL_LIVE_CLIENT_CONFIG").pipe(
      Config.option,
    );
    if (
      Option.isNone(location) ||
      environment.isDevelopment ||
      config.disableAutoUpdate ||
      policy.mode !== "auto" ||
      policy.feedUrl !== undefined
    )
      return false;
    const stat = yield* fileSystem.stat(location.value);
    if (Number(stat.size) > 3 * 1024 * 1024) return false;
    const text = yield* fileSystem.readFileString(location.value);
    const host = yield* decodeHost(text);
    if (
      typeof host !== "object" ||
      host === null ||
      !("publicKey" in host) ||
      typeof host.publicKey !== "string" ||
      host.publicKey.length > 8192 ||
      !("feedUrl" in host) ||
      typeof host.feedUrl !== "string" ||
      host.feedUrl.length > 2048 ||
      !("baseline" in host)
    )
      return false;
    const baseline = verifyManifest(host.baseline, host.publicKey);
    if (
      baseline.version !== environment.appVersion ||
      (baseline.channel === "nightly" && !policy.allowNightly)
    )
      return false;
    const current = yield* updates.getState;
    channelMatches = current.channel === (baseline.channel === "stable" ? "latest" : "nightly");
    // Clerk acquires this profile's native instance lock before the application runtime is built.
    const profile = yield* identity.resolveUserDataPath;
    const cache = yield* Effect.tryPromise({
      try: () => prepareLiveClientCache(profile),
      catch: (cause) => new LiveClientOperationError({ operation: "cache", cause }),
    });
    yield* Effect.forkScoped(
      Effect.tryPromise({
        try: cache.cleanup,
        catch: (cause) => new LiveClientOperationError({ operation: "cache", cause }),
      }).pipe(Effect.ignore),
    );
    updater = createLiveClientUpdater({
      baseline,
      baselineRoot: environment.clientAssetsDir,
      cacheRoot: cache.root,
      publicKey: host.publicKey,
      feedUrl: host.feedUrl,
      onState: (state) => {
        Queue.offerUnsafe(events, state);
      },
      onRollback: (version) => {
        Queue.offerUnsafe(events, { rollback: version });
      },
    });
    const active = updater;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        subscribeDesktopClientIdle(() => {
          if (active.getState().phase === "ready") Queue.offerUnsafe(events, active.getState());
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        clearTrialWindow();
        await active.dispose();
      }),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(events), (event) => {
        if (!("rollback" in event))
          return windows.sendAll(IpcChannels.LIVE_CLIENT_STATE_CHANNEL, event);
        return Effect.flatMap(windows.main, (window) =>
          Option.isNone(window)
            ? Effect.sync(clearTrialWindow)
            : Effect.tryPromise({
                try: async () => {
                  const crashed =
                    trialWindow?.contents.id === window.value.webContents.id && trialWindow.crashed;
                  if (window.value.webContents.isDestroyed()) {
                    clearTrialWindow();
                    return;
                  }
                  if (crashed) {
                    reloadTrialWindow(window.value.webContents);
                    return;
                  }
                  // A lost activate reply must never reload the still-running old page.
                  const boot: unknown = await window.value.webContents.executeJavaScript(
                    `({ version: document.querySelector('meta[name="t3-live-client-version"]')?.content, trial: document.documentElement.dataset.liveClientTrial, inert: document.body.inert })`,
                  );
                  if (
                    typeof boot === "object" &&
                    boot !== null &&
                    "trial" in boot &&
                    boot.trial === event.rollback &&
                    "inert" in boot &&
                    boot.inert === true
                  )
                    reloadTrialWindow(window.value.webContents);
                  else clearTrialWindow();
                },
                catch: (cause) =>
                  new LiveClientOperationError({ operation: "rollback-probe", cause }),
              }).pipe(Effect.catchCause(() => Effect.sync(clearTrialWindow))),
        );
      }),
    );
    const subscription = yield* updates.subscribe;
    yield* Effect.forkScoped(
      Stream.runForEach(subscription.changes, (state) => {
        channelMatches = state.channel === (baseline.channel === "stable" ? "latest" : "nightly");
        return state.status === "checking" && channelMatches
          ? Effect.promise(() => active.check())
          : Effect.void;
      }),
    );
    if (channelMatches) yield* Effect.forkScoped(Effect.promise(() => active.check()));
    return true;
  }).pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        disabled = { ...disabled, reason: "experimental-live-client-configuration-invalid" };
        return false;
      }),
    ),
  );

  return DesktopLiveClientUpdates.of({
    configure,
    check: Effect.promise(async () => {
      if (channelMatches) await updater?.check();
    }),
    resolveAsset: (path) => updater?.resolveAsset(path),
    getState: Effect.sync(() => updater?.getState() ?? { ...disabled }),
    activate: Effect.fn("DesktopLiveClientUpdates.activate")(function* (version: string) {
      if (
        !channelMatches ||
        hasPendingDesktopClientWork() ||
        trialWindow !== null ||
        updater?.getState().phase !== "ready"
      )
        return false;
      const window = yield* windows.main;
      if (Option.isNone(window) || window.value.webContents.isDestroyed()) return false;
      clearTrialWindow();
      const record = {
        contents: window.value.webContents,
        crashed: false,
        onCrash: () => {},
        onDestroyed: () => {},
        onLoaded: null as (() => void) | null,
        release: retainLiveClientTrial(window.value.webContents.id),
      };
      record.onCrash = () => {
        record.crashed = true;
        updater?.failActivation(version, true);
      };
      record.onDestroyed = () => {
        if (trialWindow === record) clearTrialWindow();
      };
      trialWindow = record;
      record.contents.once("render-process-gone", record.onCrash);
      record.contents.once("destroyed", record.onDestroyed);
      let accepted = false;
      try {
        accepted = updater.activate(version);
        return accepted;
      } finally {
        if (!accepted) clearTrialWindow();
      }
    }),
    acknowledge: Effect.fn("DesktopLiveClientUpdates.acknowledge")((version: string) =>
      Effect.sync(() => {
        const accepted = updater?.acknowledge(version) ?? false;
        if (accepted) clearTrialWindow();
        return accepted;
      }),
    ),
    fail: Effect.fn("DesktopLiveClientUpdates.fail")((version: string, reload: boolean) =>
      Effect.sync(() => {
        const accepted = updater?.failActivation(version, reload) ?? false;
        if (accepted && !reload) clearTrialWindow();
        return accepted;
      }),
    ),
  });
});

export const layer = Layer.effect(DesktopLiveClientUpdates, make);
