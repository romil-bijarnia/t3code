import { assert, it } from "@effect/vitest";
import { CampusError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as CampusService from "./CampusService.ts";
import * as CampusTools from "./CampusTools.ts";
import * as OnTrackApi from "./OnTrackApi.ts";

type Handler = (
  tool: string,
  args: Record<string, unknown>,
) => Effect.Effect<unknown, CampusTools.CampusToolError>;

const layerWithLane = (handler: Handler, online = true) =>
  CampusService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        OnTrackApi.OnTrackApi,
        OnTrackApi.OnTrackApi.of({
          get: (path) =>
            (online
              ? handler(`api:${path}`, {})
              : Effect.fail(
                  new CampusTools.CampusToolError({
                    lane: "deakin",
                    tool: "ontrack-token",
                    category: "unavailable",
                    detail: "The browser lane is not running and could not be started.",
                  }),
                )
            ).pipe(
              Effect.mapError(
                (error) =>
                  new CampusError({
                    app: "ontrack",
                    operation: path,
                    reason: error.category === "unavailable" ? "lane_offline" : "sign_in_required",
                    detail: error.detail,
                  }),
              ),
            ),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        CampusTools.CampusTools,
        CampusTools.CampusTools.of({
          call: ({ tool, args }) => handler(tool, args),
          laneOnline: Effect.succeed(online),
          ensureLane: Effect.succeed(online),
          readLaneFile: () => Effect.succeed(null),
          writeLaneFile: () => Effect.void,
          laneRun: (_lane, args) =>
            handler(`lane:${args[0] ?? ""}`, {}).pipe(
              Effect.map((payload) => ({
                ok: true,
                reason: null,
                detail: null,
                payload: payload as Record<string, unknown>,
              })),
              Effect.catch((error) =>
                Effect.succeed({
                  ok: false,
                  reason: "sign_in_required",
                  detail: error.detail,
                  payload: {},
                }),
              ),
            ),
        }),
      ),
    ),
  );

// OnTrack's API answers, keyed the way the fake OnTrackApi asks for them.
const apiAnswers: Record<string, unknown> = {
  "api:/api/projects/?include_in_active=false": [
    {
      id: 1,
      unit_id: 7,
      target_grade: 3,
      unit: {
        id: 7,
        code: "SIT313",
        teaching_period_id: 47,
        start_date: "2026-07-06",
        end_date: "2026-10-16",
        active: true,
      },
    },
    // OnTrack leaves `active` on for years; the dates say this one is long over.
    {
      id: 2,
      unit_id: 8,
      target_grade: 0,
      unit: {
        id: 8,
        code: "OLD101",
        teaching_period_id: 18,
        start_date: "2022-07-11",
        end_date: "2022-10-21",
        active: true,
      },
    },
  ],
  "api:/api/teaching_periods/": [
    {
      id: 18,
      period: "T2",
      year: 2022,
      start_date: "2022-07-11T00:00:00.000Z",
      end_date: "2022-10-21T00:00:00.000Z",
      active_until: "2022-11-04T00:00:00.000Z",
      active: false,
    },
    {
      id: 47,
      period: "T2",
      year: 2026,
      start_date: "2026-07-06T00:00:00.000Z",
      end_date: "2026-10-16T00:00:00.000Z",
      active_until: "2026-10-30T00:00:00.000Z",
      active: true,
    },
  ],
  "api:/api/projects/1": {
    id: 1,
    unit_id: 7,
    target_grade: 3,
    unit: { id: 7, code: "SIT313", name: "Full Stack", teaching_period_id: 47, active: true },
    tasks: [{ id: 10, task_definition_id: 100, status: "complete", due_date: "2026-07-17" }],
  },
  "api:/api/units/7": {
    id: 7,
    code: "SIT313",
    name: "Full Stack",
    teaching_period_id: 47,
    task_definitions: [
      { id: 100, abbreviation: "P1", name: "Personal Website", target_grade: 0, weighting: 5 },
    ],
  },
};

const laneFailure = (tool: string, detail: string) =>
  new CampusTools.CampusToolError({ lane: "deakin", tool, category: "failed", detail });

// Lane state the fake handlers read; each test resets what it uses.
let reads = 0;
let inboxSignedOut = false;

it.effect("reads the overview from OnTrack's API and keeps it until a refresh", () =>
  Effect.gen(function* () {
    reads = 0;
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-09T00:00:00Z")));
    const campus = yield* CampusService.CampusService;
    const first = yield* campus.ontrackOverview({});
    const second = yield* campus.ontrackOverview({});
    // The project list, the periods, then the one current project and its unit.
    assert.equal(reads, 4);
    assert.deepEqual(second, first);
    assert.deepEqual(
      first.units.map((unit) => [unit.unitCode, unit.teachingPeriod, unit.targetGrade]),
      [["SIT313", "T2 2026", 3]],
    );
    assert.equal(first.tasks[0]?.taskName, "Personal Website");
    assert.equal(first.tasks[0]?.targetGrade, 0);
    assert.equal(first.tasks[0]?.weighting, 5);
    yield* campus.ontrackOverview({ refresh: true });
    assert.equal(reads, 8);
  }).pipe(
    Effect.provide(
      layerWithLane((tool) => {
        reads += 1;
        return tool in apiAnswers
          ? Effect.succeed(apiAnswers[tool])
          : Effect.fail(laneFailure(tool, `unexpected ${tool}`));
      }),
    ),
  ),
);

it.effect("hands back the kept copy marked stale when the lane refuses a fresh read", () =>
  Effect.gen(function* () {
    inboxSignedOut = false;
    const campus = yield* CampusService.CampusService;
    const fresh = yield* campus.outlookInbox({ top: 5 });
    assert.equal(fresh.messages.length, 1);
    inboxSignedOut = true;
    const stale = yield* campus.outlookInbox({ top: 5, refresh: true });
    assert.equal(stale.messages[0]?.subject, "Results released");
    assert.equal(stale.meta.stale, true);
    assert.equal(stale.meta.issue, "sign_in_required");
    assert.match(stale.meta.note ?? "", /Outlook Mail session/);
    // Without a kept copy the failure reaches the caller.
    const missing = yield* Effect.result(campus.outlookCalendar({}));
    assert.equal(missing._tag, "Failure");
    if (missing._tag === "Failure") assert.equal(missing.failure.reason, "sign_in_required");
  }).pipe(
    Effect.provide(
      layerWithLane((tool) =>
        inboxSignedOut
          ? Effect.fail(
              laneFailure(
                tool,
                "No valid Outlook Mail session found, and assisted Microsoft sign-in did not complete.",
              ),
            )
          : Effect.succeed({ messages: [{ subject: "Results released", sender: "Deakin" }] }),
      ),
    ),
  ),
);

it.effect("reports an offline lane without touching the tools", () =>
  Effect.gen(function* () {
    const campus = yield* CampusService.CampusService;
    const status = yield* campus.status;
    assert.equal(status.laneOnline, false);
    assert.ok(status.apps.every((app) => !app.signedIn));
    const overview = yield* Effect.result(campus.ontrackOverview({}));
    assert.equal(overview._tag, "Failure");
    if (overview._tag === "Failure") assert.equal(overview.failure.reason, "lane_offline");
  }).pipe(
    Effect.provide(
      layerWithLane(() => Effect.die("tools must not be called while the lane is down"), false),
    ),
  ),
);

it.effect("derives each app's sign-in from both lanes", () =>
  Effect.gen(function* () {
    const campus = yield* CampusService.CampusService;
    const status = yield* campus.status;
    assert.equal(status.laneOnline, true);
    assert.deepEqual(
      status.apps.map((app) => [app.app, app.signedIn]),
      [
        ["ontrack", true],
        ["deakinsync", false],
        ["teams", true],
        ["outlook", false],
      ],
    );
    assert.match(status.apps[3]?.detail ?? "", /Missing: mail/);
  }).pipe(
    Effect.provide(
      layerWithLane((tool) =>
        tool === "session_status"
          ? Effect.succeed({
              portals: { ontrack: { authenticated: true }, deakinsync: { authenticated: false } },
            })
          : Effect.fail(
              laneFailure(
                tool,
                "Microsoft web session is incomplete. Missing: mail, calendar. Run the local Microsoft login flow first.",
              ),
            ),
      ),
    ),
  ),
);
