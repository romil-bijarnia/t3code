import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";

import * as CampusTools from "./CampusTools.ts";
import * as OnTrackApi from "./OnTrackApi.ts";

interface Lane {
  online: boolean;
  mints: number;
  readonly files: Map<string, string>;
}

interface Answer {
  readonly status: number;
  readonly body: string;
}

const lane = (): Lane => ({ online: true, mints: 0, files: new Map() });

const toolsLayer = (state: Lane) =>
  Layer.succeed(
    CampusTools.CampusTools,
    CampusTools.CampusTools.of({
      call: () => Effect.die("the API path must not drive the lane's MCP tools"),
      laneOnline: Effect.sync(() => state.online),
      ensureLane: Effect.sync(() => state.online),
      readLaneFile: (path) => Effect.sync(() => state.files.get(path) ?? null),
      writeLaneFile: (path, text) =>
        Effect.sync(() => {
          if (text === null) state.files.delete(path);
          else state.files.set(path, text);
        }),
      laneRun: () =>
        Effect.sync(() => {
          state.mints += 1;
          return {
            ok: true,
            reason: null,
            detail: null,
            payload: { authToken: `token-${state.mints}`, username: "s222528574" },
          };
        }),
    }),
  );

const httpLayer = (
  requests: Array<HttpClientRequest.HttpClientRequest>,
  answer: (request: HttpClientRequest.HttpClientRequest, index: number) => Answer,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      const { status, body } = answer(request, requests.length);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status, headers: { "content-type": "application/json" } }),
        ),
      );
    }),
  );

const apiLayer = (
  state: Lane,
  requests: Array<HttpClientRequest.HttpClientRequest>,
  answer: Parameters<typeof httpLayer>[1],
) =>
  OnTrackApi.layer.pipe(
    Layer.provide(Layer.mergeAll(toolsLayer(state), httpLayer(requests, answer))),
  );

const ok: Answer = { status: 200, body: `{"id": 1}` };
const refused: Answer = { status: 419, body: `{"error": "token expired"}` };

it.effect("mints one token through the lane and sends it with every request", () => {
  const state = lane();
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  return Effect.gen(function* () {
    const api = yield* OnTrackApi.OnTrackApi;
    const first = yield* api.get("/api/projects/1");
    yield* api.get("/api/units/7");
    assert.deepEqual(first, { id: 1 });
    assert.equal(state.mints, 1);
    assert.deepEqual(
      requests.map((request) => [
        request.url,
        request.headers["auth-token"],
        request.headers["username"],
      ]),
      [
        ["https://ontrack.deakin.edu.au/api/projects/1", "token-1", "s222528574"],
        ["https://ontrack.deakin.edu.au/api/units/7", "token-1", "s222528574"],
      ],
    );
    assert.match(state.files.get("t3-ontrack-token.json") ?? "", /token-1/);
  }).pipe(Effect.provide(apiLayer(state, requests, () => ok)));
});

it.effect("starts from the token an earlier run saved", () => {
  const state = lane();
  state.files.set("t3-ontrack-token.json", `{"authToken":"saved","username":"s222528574"}`);
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  return Effect.gen(function* () {
    const api = yield* OnTrackApi.OnTrackApi;
    yield* api.get("/api/projects/1");
    assert.equal(state.mints, 0);
    assert.equal(requests[0]?.headers["auth-token"], "saved");
  }).pipe(Effect.provide(apiLayer(state, requests, () => ok)));
});

it.effect("renews the token once when OnTrack refuses it", () => {
  const state = lane();
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  return Effect.gen(function* () {
    const api = yield* OnTrackApi.OnTrackApi;
    const answer = yield* api.get("/api/projects/1");
    assert.deepEqual(answer, { id: 1 });
    assert.equal(state.mints, 2);
    assert.deepEqual(
      requests.map((request) => request.headers["auth-token"]),
      ["token-1", "token-2"],
    );
    assert.match(state.files.get("t3-ontrack-token.json") ?? "", /token-2/);
  }).pipe(
    Effect.provide(apiLayer(state, requests, (_request, index) => (index === 1 ? refused : ok))),
  );
});

it.effect("asks for a sign-in when OnTrack refuses a fresh token too", () => {
  const state = lane();
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  return Effect.gen(function* () {
    const api = yield* OnTrackApi.OnTrackApi;
    const result = yield* Effect.result(api.get("/api/projects/1"));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "sign_in_required");
    assert.equal(state.mints, 2);
    assert.equal(requests.length, 2);
  }).pipe(Effect.provide(apiLayer(state, requests, () => refused)));
});

it.effect("reports the lane offline when a token is needed and the broker is down", () => {
  const state = lane();
  state.online = false;
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  return Effect.gen(function* () {
    const api = yield* OnTrackApi.OnTrackApi;
    const result = yield* Effect.result(api.get("/api/projects/1"));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "lane_offline");
    assert.equal(state.mints, 0);
    assert.equal(requests.length, 0);
  }).pipe(Effect.provide(apiLayer(state, requests, () => ok)));
});
