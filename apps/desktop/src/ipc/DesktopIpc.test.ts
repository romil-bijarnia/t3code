import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";
import { hasPendingDesktopClientWork } from "./liveClientWork.ts";

it.effect(
  "defers client activation while a native request is pending and releases on failure",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<string, string>();
      const listeners = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
      const ipc = DesktopIpc.make(
        {
          removeHandler: (channel) => {
            listeners.delete(channel);
          },
          handle: (channel, listener) => {
            listeners.set(channel, listener);
          },
          removeAllListeners: () => {},
          on: () => {},
        },
        () => Effect.succeed(true),
      );
      yield* ipc.handle({
        channel: "desktop:pick-folder",
        handler: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      });
      const result = Promise.resolve(
        listeners.get("desktop:pick-folder")!({ sender: { id: 1 } }, undefined),
      ).catch(() => "failed");
      yield* Deferred.await(started);
      assert.strictEqual(hasPendingDesktopClientWork(), true);
      yield* Deferred.fail(finish, "cancelled");
      assert.strictEqual(yield* Effect.promise(() => result), "failed");
      assert.strictEqual(hasPendingDesktopClientWork(), false);
    }),
);

it.effect("answers only the main window's top frame", () =>
  Effect.gen(function* () {
    const mainFrame = {};
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome({
                webContents: { id: 1, mainFrame },
              } as unknown as Electron.BrowserWindow),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "token",
        payload: Schema.Void,
        result: Schema.String,
        handler: () => Effect.succeed("secret"),
      }),
    );
    yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

    const senders = {
      app: { sender: { id: 1 }, senderFrame: mainFrame },
      appSubframe: { sender: { id: 1 }, senderFrame: {} },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      app: ["secret", "secret"],
      appSubframe: ["rejected", undefined],
      previewGuest: ["rejected", undefined],
    });
  }),
);
