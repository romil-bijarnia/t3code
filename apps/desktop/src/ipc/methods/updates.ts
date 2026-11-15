import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
  DesktopLiveClientUpdateStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as DesktopLiveClientUpdates from "../../updates/DesktopLiveClientUpdates.ts";
import * as Option from "effect/Option";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getLiveClientTrial = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.LIVE_CLIENT_TRIAL_CHANNEL,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.liveClient.trial")(function* () {
    const live = yield* Effect.serviceOption(DesktopLiveClientUpdates.DesktopLiveClientUpdates);
    if (Option.isNone(live)) return null;
    const state = yield* live.value.getState;
    return state.phase === "activating" ? state.candidateVersion : null;
  }),
});

export const getLiveClientState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIVE_CLIENT_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopLiveClientUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.liveClient.getState")(function* () {
    const live = yield* Effect.serviceOption(DesktopLiveClientUpdates.DesktopLiveClientUpdates);
    return Option.isSome(live)
      ? yield* live.value.getState
      : {
          phase: "disabled" as const,
          currentVersion: "",
          candidateVersion: null,
          reason: "not-configured",
        };
  }),
});

export const activateLiveClient = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIVE_CLIENT_ACTIVATE_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.liveClient.activate")(function* (version) {
    const live = yield* Effect.serviceOption(DesktopLiveClientUpdates.DesktopLiveClientUpdates);
    return Option.isSome(live) ? yield* live.value.activate(version) : false;
  }),
});

export const acknowledgeLiveClient = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIVE_CLIENT_READY_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.liveClient.ready")(function* (version) {
    const live = yield* Effect.serviceOption(DesktopLiveClientUpdates.DesktopLiveClientUpdates);
    return Option.isSome(live) ? yield* live.value.acknowledge(version) : false;
  }),
});

export const failLiveClient = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIVE_CLIENT_FAIL_CHANNEL,
  payload: Schema.Struct({ version: Schema.String, reload: Schema.Boolean }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.liveClient.fail")(function* ({ version, reload }) {
    const live = yield* Effect.serviceOption(DesktopLiveClientUpdates.DesktopLiveClientUpdates);
    return Option.isSome(live) ? yield* live.value.fail(version, reload) : false;
  }),
});

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: Schema.Struct({
    channel: DesktopUpdateChannelSchema,
    minimumVersion: Schema.optional(Schema.String),
  }),
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* ({ channel, minimumVersion }) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setChannel(channel, { minimumVersion });
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  /** A version installs only that downloaded build, never one that replaced it. */
  payload: Schema.UndefinedOr(Schema.String),
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* (expectedVersion) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    if (expectedVersion === undefined) return yield* updates.install;
    const { accepted, completed, state } = yield* updates.installPrepared(expectedVersion);
    return { accepted, completed, state };
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    const result = yield* updates.check("web-ui");
    const live = yield* Effect.serviceOption(DesktopLiveClientUpdates.DesktopLiveClientUpdates);
    if (Option.isSome(live)) yield* live.value.check;
    return result;
  }),
});
