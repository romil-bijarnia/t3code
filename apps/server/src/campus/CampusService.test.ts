import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CampusService from "./CampusService.ts";
import * as CampusTools from "./CampusTools.ts";

type Handler = (
  tool: string,
  args: Record<string, unknown>,
) => Effect.Effect<unknown, CampusTools.CampusToolError>;

const layerWithLane = (handler: Handler, online = true) =>
  CampusService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        CampusTools.CampusTools,
        CampusTools.CampusTools.of({
          call: ({ tool, args }) => handler(tool, args),
          laneOnline: Effect.succeed(online),
          ensureLane: Effect.succeed(online),
          readLaneFile: () => Effect.succeed(null),
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

const unit = { projectId: 1, unitCode: "SIT313", unitName: "Full Stack", isCurrent: true };
const task = {
  projectId: 1,
  taskId: 10,
  taskDefinitionId: 100,
  unitCode: "SIT313",
  taskAbbreviation: "P1",
  taskName: "Personal Website",
  status: "complete",
};

const laneFailure = (tool: string, detail: string) =>
  new CampusTools.CampusToolError({ lane: "deakin", tool, category: "failed", detail });

// Lane state the fake handlers read; each test resets what it uses.
let reads = 0;
let inboxSignedOut = false;

it.effect("serves the kept overview until a refresh is asked for", () =>
  Effect.gen(function* () {
    reads = 0;
    const campus = yield* CampusService.CampusService;
    const first = yield* campus.ontrackOverview({});
    const second = yield* campus.ontrackOverview({});
    assert.equal(reads, 2);
    assert.deepEqual(second, first);
    assert.equal(first.units[0]?.unitCode, "SIT313");
    assert.equal(first.tasks[0]?.taskName, "Personal Website");
    yield* campus.ontrackOverview({ refresh: true });
    assert.equal(reads, 4);
  }).pipe(
    Effect.provide(
      layerWithLane((tool) => {
        reads += 1;
        return Effect.succeed(
          tool === "list_units"
            ? { units: [unit] }
            : { project: { projectId: 1, targetGrade: 2 }, tasks: [task] },
        );
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
