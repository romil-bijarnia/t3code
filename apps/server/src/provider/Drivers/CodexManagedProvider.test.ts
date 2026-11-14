import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  LiveVoiceError,
  ProviderInstanceId,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { HttpClient } from "effect/http";
import type { CodexChatGptCredentials } from "../CodexChatGptAuth.ts";
import { makeManagedCodexLiveVoice } from "./CodexManagedProvider.ts";

const native = vi.hoisted(() => ({ make: vi.fn() }));
vi.mock("../CodexLiveVoice.ts", () => ({ makeCodexLiveVoice: native.make }));

const instanceId = ProviderInstanceId.make("managed-voice-test");
const config = Schema.decodeSync(CodexSettings)({ setupMode: "managed" });
const credentials = (subject: string): CodexChatGptCredentials => ({
  clientId: "fixture-app",
  subject,
  accessToken: `${subject}-fixture-access`,
  refreshToken: null,
  expiresAt: Number.MAX_SAFE_INTEGER,
  earliestRefreshAt: null,
  scopes: ["chatgpt.tokens.use.direct"],
  email: null,
});
const input = {
  sdp: "fixture-offer",
  voice: "aube",
  context: [{ role: "user" as const, text: "Account A conversation" }],
};

type ResolvedVoice = {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
  readonly subscriptionToken: Redacted.Redacted<string>;
};

const fixture = Effect.gen(function* () {
  const selected = yield* Ref.make(credentials("profile-a"));
  const runtimeResolved = yield* Deferred.make<void>();
  const releaseRuntime = yield* Deferred.make<void>();
  const accessStarted = yield* Deferred.make<void>();
  const releaseAccess = yield* Deferred.make<void>();
  const requests = yield* Ref.make<
    ReadonlyArray<{ revision: string; token: string; context: typeof input.context }>
  >([]);
  const closed = yield* Ref.make(false);
  let blockRuntime = false;
  let blockAccess = false;
  const controller = yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "t3", key: "fixture-managed-voice" },
    methods: Effect.succeed([]),
    authenticate: () => Effect.void,
    logout: Effect.void,
  });
  native.make.mockImplementation(
    (resolve: Effect.Effect<ResolvedVoice, ProviderSetupError, Scope.Scope>) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<Scope.Scope>();
        const configuration = resolve.pipe(
          Effect.provide(context),
          Effect.mapError(() => new LiveVoiceError({ reason: "authentication" })),
        );
        return {
          options: configuration.pipe(Effect.as({ voices: ["aube"], defaultVoice: "aube" })),
          open: (request: typeof input) =>
            Effect.gen(function* () {
              const effective = yield* configuration;
              yield* Ref.update(requests, (previous) => [
                ...previous,
                {
                  revision: effective.revision,
                  token: Redacted.value(effective.subscriptionToken),
                  context: request.context,
                },
              ]);
              yield* Effect.addFinalizer(() => Ref.set(closed, true));
              return { sdp: "fixture-answer", events: Stream.never, send: () => Effect.void };
            }),
        };
      }),
  );
  const runtime = {
    resolve: Effect.gen(function* () {
      const profile = yield* Ref.get(selected);
      yield* Deferred.succeed(runtimeResolved, undefined);
      if (blockRuntime) yield* Deferred.await(releaseRuntime);
      return { config, environment: {}, revision: profile.subject };
    }),
    auth: {
      controller,
      access: Effect.gen(function* () {
        yield* Deferred.succeed(accessStarted, undefined);
        if (blockAccess) yield* Deferred.await(releaseAccess);
        return yield* Ref.get(selected);
      }),
      profileKey: (profile: CodexChatGptCredentials) => Effect.succeed(profile.subject),
    },
  };
  const voice = yield* makeManagedCodexLiveVoice(instanceId, runtime);
  return {
    voice,
    controller,
    selected,
    runtimeResolved,
    releaseRuntime,
    accessStarted,
    releaseAccess,
    requests,
    closed,
    blockRuntime: () => {
      blockRuntime = true;
    },
    blockAccess: () => {
      blockAccess = true;
    },
  };
});

it.effect("refuses a replacement profile read after resolving the managed voice runtime", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.blockRuntime();
    const opening = yield* f.voice.open(input).pipe(Effect.forkChild);
    yield* Deferred.await(f.runtimeResolved);
    yield* Ref.set(f.selected, credentials("profile-b"));
    yield* Deferred.succeed(f.releaseRuntime, undefined);
    const result = yield* Fiber.await(opening);
    assert.deepEqual(yield* Ref.get(f.requests), []);
    assert.isTrue(Exit.isFailure(result));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected network request in managed voice fixture")),
        ),
      ),
    ),
  ),
);

it.effect("credential adoption drains a managed voice opening before replacing its account", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.blockAccess();
    const opening = yield* f.voice.open(input).pipe(Effect.forkChild);
    yield* Deferred.await(f.accessStarted);
    yield* f.controller.adoptCredentials!(
      Ref.set(f.selected, credentials("profile-b")),
      Effect.void,
    );
    yield* Deferred.succeed(f.releaseAccess, undefined);
    const result = yield* Fiber.await(opening);
    assert.deepEqual(yield* Ref.get(f.requests), []);
    assert.isTrue(Exit.isFailure(result));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected network request in managed voice fixture")),
        ),
      ),
    ),
  ),
);

it.effect(
  "keeps the acquired voice connection in auth admission until its account is replaced",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.voice.open(input);
      assert.deepEqual(yield* Ref.get(f.requests), [
        { revision: "profile-a", token: "profile-a-fixture-access", context: input.context },
      ]);
      assert.isFalse(yield* Ref.get(f.closed));
      yield* f.controller.adoptCredentials!(
        Ref.set(f.selected, credentials("profile-b")),
        Effect.void,
      );
      assert.isTrue(yield* Ref.get(f.closed));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Effect.die("Unexpected network request in managed voice fixture"),
            ),
          ),
        ),
      ),
    ),
);
