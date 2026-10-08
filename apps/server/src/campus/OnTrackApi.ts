import { CampusError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as CampusTools from "./CampusTools.ts";

/**
 * OnTrack's own JSON API, called directly. OnTrack (Doubtfire) answers any
 * client that sends the username and an auth token; only minting that token
 * needs Deakin's single sign-on, which the lane does headlessly. Everything
 * the dashboard shows comes through here in well under a second.
 *
 * The token is kept in a private file beside the lane's data so a restarted
 * server carries on without another sign-in; OnTrack refusing it is what
 * triggers a new one.
 */
export class OnTrackApi extends Context.Service<
  OnTrackApi,
  {
    /** GET `/api/...` as JSON, minting or renewing the token when OnTrack asks for one. */
    readonly get: (path: string) => Effect.Effect<unknown, CampusError>;
  }
>()("t3/campus/OnTrackApi") {}

const OnTrackToken = Schema.Struct({ authToken: Schema.String, username: Schema.String });
type OnTrackToken = typeof OnTrackToken.Type;
const TokenFile = Schema.fromJsonString(OnTrackToken);
const readTokenFile = Schema.decodeUnknownOption(TokenFile);
const writeTokenFile = Schema.encodeSync(TokenFile);

const TOKEN_FILENAME = "t3-ontrack-token.json";
const DEFAULT_BASE_URL = "https://ontrack.deakin.edu.au";
const TOKEN_REFUSED = new Set([401, 419]);

const make = Effect.gen(function* () {
  const tools = yield* CampusTools.CampusTools;
  const http = yield* HttpClient.HttpClient;
  const baseUrl = process.env.T3_ONTRACK_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const saved = yield* tools.readLaneFile(TOKEN_FILENAME);
  const tokenRef = yield* Ref.make<OnTrackToken | null>(
    saved === null ? null : Option.getOrNull(readTokenFile(saved)),
  );

  const mint = (operation: string) =>
    Effect.gen(function* () {
      const online = yield* tools.ensureLane;
      if (!online) {
        return yield* new CampusError({
          app: "ontrack",
          operation,
          reason: "lane_offline",
          detail: "The browser lane is not running and could not be started.",
        });
      }
      const minted = yield* tools.laneRun("deakin", ["ontrack-token"]).pipe(
        Effect.mapError(
          (error) =>
            new CampusError({
              app: "ontrack",
              operation,
              reason: "lane_offline",
              detail: error.detail || "The lane could not sign in to OnTrack.",
            }),
        ),
      );
      const authToken = minted.payload.authToken;
      const username = minted.payload.username;
      if (!minted.ok || typeof authToken !== "string" || typeof username !== "string") {
        return yield* new CampusError({
          app: "ontrack",
          operation,
          reason: minted.reason === "sign_in_required" ? "sign_in_required" : "tool_failed",
          detail: minted.detail ?? "OnTrack did not issue a token.",
        });
      }
      const token: OnTrackToken = { authToken, username };
      yield* Ref.set(tokenRef, token);
      yield* tools.writeLaneFile(TOKEN_FILENAME, writeTokenFile(token));
      return token;
    });

  const request = (path: string, token: OnTrackToken) =>
    http
      .execute(
        HttpClientRequest.get(`${baseUrl}${path}`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json",
            "auth-token": token.authToken,
            username: token.username,
          }),
        ),
      )
      .pipe(
        Effect.mapError(
          () =>
            new CampusError({
              app: "ontrack",
              operation: path,
              reason: "tool_failed",
              detail: "OnTrack did not answer.",
            }),
        ),
      );

  const get: OnTrackApi["Service"]["get"] = (path) =>
    Effect.gen(function* () {
      let token = (yield* Ref.get(tokenRef)) ?? (yield* mint(path));
      let response = yield* request(path, token);
      if (TOKEN_REFUSED.has(response.status)) {
        // The token aged out; one fresh token, then the answer stands.
        yield* Ref.set(tokenRef, null);
        token = yield* mint(path);
        response = yield* request(path, token);
        if (TOKEN_REFUSED.has(response.status)) {
          return yield* new CampusError({
            app: "ontrack",
            operation: path,
            reason: "sign_in_required",
            detail: "OnTrack no longer accepts this session; sign in again.",
          });
        }
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new CampusError({
          app: "ontrack",
          operation: path,
          reason: "tool_failed",
          detail: `OnTrack answered ${response.status}.`,
        });
      }
      const body = yield* Effect.result(response.json);
      if (Result.isFailure(body)) {
        return yield* new CampusError({
          app: "ontrack",
          operation: path,
          reason: "tool_failed",
          detail: "OnTrack answered with something other than JSON.",
        });
      }
      return body.success;
    });

  return OnTrackApi.of({ get });
});

export const layer = Layer.effect(OnTrackApi, make);
