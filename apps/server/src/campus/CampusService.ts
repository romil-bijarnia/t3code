import {
  type CampusApp,
  type CampusDeakinSyncPageInput,
  type CampusDeakinSyncPageResult,
  CampusError,
  type CampusFetchMeta,
  type CampusListInput,
  type CampusOnTrackOverviewInput,
  type CampusOnTrackOverviewResult,
  type CampusOnTrackTaskInput,
  type CampusOnTrackTaskResult,
  type CampusOutlookCalendarResult,
  type CampusOutlookEmailInput,
  type CampusOutlookEmailResult,
  type CampusOutlookInboxResult,
  type CampusSignInInput,
  type CampusSignInResult,
  type CampusStatusResult,
  type CampusTeamsThreadInput,
  type CampusTeamsThreadResult,
  type CampusTeamsThreadsInput,
  type CampusTeamsThreadsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as CampusTools from "./CampusTools.ts";
import {
  classifyLaneFailure,
  deakinSignIn,
  microsoftSignIn,
  normalizeOnTrackOverview,
  normalizeOnTrackTaskDetails,
  normalizeOutlookCalendar,
  normalizeOutlookEmail,
  normalizeOutlookInbox,
  normalizePortalPage,
  normalizeTeamsThread,
  normalizeTeamsThreads,
} from "./normalize.ts";

/**
 * What the campus pages read: OnTrack, DeakinSync, Teams and Outlook, each
 * answered through the browser lane and kept for a few minutes so a page
 * paints at once and a dropped lane still shows the last copy.
 */
export class CampusService extends Context.Service<
  CampusService,
  {
    readonly status: Effect.Effect<CampusStatusResult, CampusError>;
    readonly ontrackOverview: (
      input: CampusOnTrackOverviewInput,
    ) => Effect.Effect<CampusOnTrackOverviewResult, CampusError>;
    readonly ontrackTask: (
      input: CampusOnTrackTaskInput,
    ) => Effect.Effect<CampusOnTrackTaskResult, CampusError>;
    readonly outlookInbox: (
      input: CampusListInput,
    ) => Effect.Effect<CampusOutlookInboxResult, CampusError>;
    readonly outlookEmail: (
      input: CampusOutlookEmailInput,
    ) => Effect.Effect<CampusOutlookEmailResult, CampusError>;
    readonly outlookCalendar: (
      input: CampusListInput,
    ) => Effect.Effect<CampusOutlookCalendarResult, CampusError>;
    readonly teamsThreads: (
      input: CampusTeamsThreadsInput,
    ) => Effect.Effect<CampusTeamsThreadsResult, CampusError>;
    readonly teamsThread: (
      input: CampusTeamsThreadInput,
    ) => Effect.Effect<CampusTeamsThreadResult, CampusError>;
    readonly deakinsyncPage: (
      input: CampusDeakinSyncPageInput,
    ) => Effect.Effect<CampusDeakinSyncPageResult, CampusError>;
    /** Opens the lane's own sign-in window for the person; resolves once they finish or give up. */
    readonly signIn: (input: CampusSignInInput) => Effect.Effect<CampusSignInResult, CampusError>;
  }
>()("t3/campus/CampusService") {}

const CAMPUS_APPS: ReadonlyArray<CampusApp> = ["ontrack", "deakinsync", "teams", "outlook"];
/** How long a kept answer counts as current before a page's read goes back to the lane. */
const FRESH_FOR_MS = 5 * 60_000;
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_LIST_TOP = 20;

const laneOf = (app: CampusApp): CampusTools.CampusLane =>
  app === "ontrack" || app === "deakinsync" ? "deakin" : "microsoft";

/** How long a lane's refusal to read without a sign-in is taken at its word before asking again. */
const SIGN_IN_MEMO_MS = 90_000;

/** The lane's own on-disk copies of OnTrack lists: `{ cachedAt, payload }`. */
const LaneCacheFile = Schema.fromJsonString(
  Schema.Struct({ cachedAt: Schema.String, payload: Schema.Unknown }),
);
const decodeLaneCacheFile = Schema.decodeUnknownOption(LaneCacheFile);
const ONTRACK_UNITS_FILE = "cache/list_units_current_true.json";
const ONTRACK_TASKS_FILE =
  "cache/list_tasks__current_true__completed_true__project_all__unit_all.json";

const make = Effect.gen(function* () {
  const tools = yield* CampusTools.CampusTools;
  const kept = new Map<string, { readonly value: unknown; readonly at: number }>();
  // A lane that just said "sign in first" takes tens of seconds to say it again,
  // so every page of that lane fails fast on the memo until a refresh or sign-in.
  const signInMissing = new Map<CampusTools.CampusLane, { at: number; detail: string }>();
  const stamp = Effect.map(DateTime.now, (moment) => ({
    iso: DateTime.formatIso(moment),
    ms: DateTime.toEpochMillis(moment),
  }));

  const laneCall = (input: {
    readonly app: CampusApp;
    readonly operation: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly timeoutMs?: number;
    /** A forced read asks the lane again even when it recently wanted a sign-in. */
    readonly refresh?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      const lane = laneOf(input.app);
      const memo = signInMissing.get(lane);
      const { ms: startedAt } = yield* stamp;
      if (memo && input.refresh !== true && startedAt - memo.at < SIGN_IN_MEMO_MS) {
        return yield* new CampusError({
          app: input.app,
          operation: input.operation,
          reason: "sign_in_required",
          detail: memo.detail,
        });
      }
      if (input.refresh === true) signInMissing.delete(lane);
      const online = yield* tools.ensureLane;
      if (!online) {
        return yield* new CampusError({
          app: input.app,
          operation: input.operation,
          reason: "lane_offline",
          detail: "The browser lane is not running and could not be started.",
        });
      }
      const result = yield* Effect.result(
        tools.call({
          lane,
          tool: input.tool,
          args: input.args,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        }),
      );
      if (Result.isSuccess(result)) return result.success;
      const reason =
        result.failure.category === "unavailable"
          ? "lane_offline"
          : classifyLaneFailure(result.failure.detail);
      const detail = result.failure.detail || `${input.tool} did not answer.`;
      if (reason === "sign_in_required") {
        signInMissing.set(lane, { at: (yield* stamp).ms, detail });
      }
      return yield* new CampusError({ app: input.app, operation: input.operation, reason, detail });
    });

  /**
   * Serves the kept copy while it is fresh, otherwise reads; a failed read
   * with a kept copy hands that copy back marked stale with the lane's reason,
   * so a page keeps its content and shows what to do.
   */
  const keep = <A extends { readonly meta: CampusFetchMeta }>(
    key: string,
    refresh: boolean | undefined,
    read: Effect.Effect<A, CampusError>,
  ): Effect.Effect<A, CampusError> =>
    Effect.gen(function* () {
      const hit = kept.get(key);
      const { ms: startedAt } = yield* stamp;
      if (hit && refresh !== true && startedAt - hit.at < FRESH_FOR_MS) return hit.value as A;
      const result = yield* Effect.result(read);
      if (Result.isSuccess(result)) {
        kept.set(key, { value: result.success, at: (yield* stamp).ms });
        return result.success;
      }
      if (!hit) return yield* result.failure;
      const previous = hit.value as A;
      return {
        ...previous,
        meta: {
          ...previous.meta,
          stale: true,
          note: result.failure.detail,
          issue: result.failure.reason,
        },
      };
    });

  const status: CampusService["Service"]["status"] = Effect.gen(function* () {
    const laneOnline = yield* tools.ensureLane;
    const checkedAt = (yield* stamp).iso;
    if (!laneOnline) {
      return {
        laneOnline: false,
        apps: CAMPUS_APPS.map((app) => ({
          app,
          signedIn: false,
          detail: "The browser lane is offline.",
        })),
        checkedAt,
      };
    }
    const deakin = yield* Effect.result(
      tools.call({ lane: "deakin", tool: "session_status", args: {} }),
    );
    const deakinSession = Result.isSuccess(deakin)
      ? deakinSignIn(deakin.success)
      : { ontrack: false, deakinsync: false };
    const deakinDetail = Result.isSuccess(deakin) ? null : deakin.failure.detail;
    const microsoft = yield* Effect.result(
      tools.call({ lane: "microsoft", tool: "microsoft_session_status", args: {} }),
    );
    const microsoftSession = microsoftSignIn(
      Result.isSuccess(microsoft)
        ? { ok: true, message: null }
        : { ok: false, message: microsoft.failure.detail },
    );
    const microsoftDetail = Result.isSuccess(microsoft) ? null : microsoft.failure.detail;
    const signInDetail = (signedIn: boolean, detail: string | null) =>
      signedIn ? null : (detail ?? "Sign in to continue.");
    return {
      laneOnline: true,
      apps: [
        {
          app: "ontrack",
          signedIn: deakinSession.ontrack,
          detail: signInDetail(deakinSession.ontrack, deakinDetail),
        },
        {
          app: "deakinsync",
          signedIn: deakinSession.deakinsync,
          detail: signInDetail(deakinSession.deakinsync, deakinDetail),
        },
        {
          app: "teams",
          signedIn: microsoftSession.teams,
          detail: signInDetail(microsoftSession.teams, microsoftDetail),
        },
        {
          app: "outlook",
          signedIn: microsoftSession.outlook,
          detail: signInDetail(microsoftSession.outlook, microsoftDetail),
        },
      ],
      checkedAt,
    };
  });

  /**
   * The lane keeps its last OnTrack lists on disk; a page paints from those at
   * once and asks for the live read behind them, instead of waiting out a
   * signed-out lane's slow refusal with nothing to show.
   */
  const ontrackOverviewFromLaneFiles = Effect.gen(function* () {
    const units = decodeLaneCacheFile((yield* tools.readLaneFile(ONTRACK_UNITS_FILE)) ?? "");
    const tasks = decodeLaneCacheFile((yield* tools.readLaneFile(ONTRACK_TASKS_FILE)) ?? "");
    if (Option.isNone(units) || Option.isNone(tasks)) return null;
    const overview = normalizeOnTrackOverview({
      units: { units: units.value.payload },
      tasks: { tasks: tasks.value.payload },
      fetchedAt: tasks.value.cachedAt,
    });
    return {
      ...overview,
      meta: {
        fetchedAt: tasks.value.cachedAt,
        stale: true,
        note: "The lane's last copy; a live read follows.",
        issue: null,
      },
    };
  });

  const ontrackOverview: CampusService["Service"]["ontrackOverview"] = (input) =>
    Effect.gen(function* () {
      if (input.refresh !== true && !kept.has("ontrack:overview")) {
        const fromFiles = yield* ontrackOverviewFromLaneFiles;
        if (fromFiles) return fromFiles;
      }
      return yield* keep(
        "ontrack:overview",
        input.refresh,
        Effect.gen(function* () {
          const units = yield* laneCall({
            app: "ontrack",
            operation: "ontrackOverview",
            tool: "list_units",
            args: { currentOnly: true },
            refresh: input.refresh,
          });
          const tasks = yield* laneCall({
            app: "ontrack",
            operation: "ontrackOverview",
            tool: "list_tasks",
            args: { currentOnly: true, includeCompleted: true },
            refresh: input.refresh,
          });
          return normalizeOnTrackOverview({ units, tasks, fetchedAt: (yield* stamp).iso });
        }),
      );
    });

  const ontrackTask: CampusService["Service"]["ontrackTask"] = (input) =>
    keep(
      `ontrack:task:${input.projectId}:${input.taskId}`,
      input.refresh,
      Effect.gen(function* () {
        const raw = yield* laneCall({
          app: "ontrack",
          operation: "ontrackTask",
          tool: "get_ontrack_task_details",
          refresh: input.refresh,
          args: {
            projectId: input.projectId,
            taskId: input.taskId,
            taskAbbreviation: input.taskAbbreviation,
          },
        });
        const details = normalizeOnTrackTaskDetails({ raw, fetchedAt: (yield* stamp).iso });
        if (!details) {
          return yield* new CampusError({
            app: "ontrack",
            operation: "ontrackTask",
            reason: "tool_failed",
            detail: "OnTrack returned no task for that id.",
          });
        }
        return details;
      }),
    );

  const outlookInbox: CampusService["Service"]["outlookInbox"] = (input) =>
    keep(
      `outlook:inbox:${input.top ?? DEFAULT_LIST_TOP}`,
      input.refresh,
      laneCall({
        app: "outlook",
        operation: "outlookInbox",
        tool: "list_outlook_unread_emails_local",
        refresh: input.refresh,
        args: { top: input.top ?? DEFAULT_LIST_TOP, allowInteractiveRecovery: false },
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.map(stamp, ({ iso }) => normalizeOutlookInbox({ raw, fetchedAt: iso })),
        ),
      ),
    );

  const outlookEmail: CampusService["Service"]["outlookEmail"] = (input) =>
    keep(
      `outlook:email:${input.subject}`,
      input.refresh,
      laneCall({
        app: "outlook",
        operation: "outlookEmail",
        tool: "read_outlook_email_local",
        refresh: input.refresh,
        args: {
          message: input.subject,
          includeConversation: true,
          allowInteractiveRecovery: false,
        },
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.map(stamp, ({ iso }) => normalizeOutlookEmail({ raw, fetchedAt: iso })),
        ),
      ),
    );

  const outlookCalendar: CampusService["Service"]["outlookCalendar"] = (input) =>
    keep(
      `outlook:calendar:${input.top ?? DEFAULT_LIST_TOP}`,
      input.refresh,
      laneCall({
        app: "outlook",
        operation: "outlookCalendar",
        tool: "list_outlook_calendar_events_local",
        refresh: input.refresh,
        args: { top: input.top ?? DEFAULT_LIST_TOP, allowInteractiveRecovery: false },
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.map(stamp, ({ iso }) => normalizeOutlookCalendar({ raw, fetchedAt: iso })),
        ),
      ),
    );

  const teamsThreads: CampusService["Service"]["teamsThreads"] = (input) =>
    keep(
      `teams:threads:${input.top ?? DEFAULT_LIST_TOP}:${input.cursor ?? ""}`,
      input.refresh,
      laneCall({
        app: "teams",
        operation: "teamsThreads",
        tool: "list_teams_threads_local",
        refresh: input.refresh,
        args: {
          top: input.top ?? DEFAULT_LIST_TOP,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          maxPages: 4,
          allowInteractiveRecovery: false,
        },
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.map(stamp, ({ iso }) => normalizeTeamsThreads({ raw, fetchedAt: iso })),
        ),
      ),
    );

  const teamsThread: CampusService["Service"]["teamsThread"] = (input) =>
    keep(
      `teams:thread:${input.threadRef}:${input.cursor ?? ""}`,
      input.refresh,
      laneCall({
        app: "teams",
        operation: "teamsThread",
        tool: "read_teams_thread_local",
        refresh: input.refresh,
        args: {
          threadRef: input.threadRef,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit: 50,
          includeReplies: true,
          allowInteractiveRecovery: false,
        },
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.map(stamp, ({ iso }) => normalizeTeamsThread({ raw, fetchedAt: iso })),
        ),
      ),
    );

  const deakinsyncPage: CampusService["Service"]["deakinsyncPage"] = (input) =>
    keep(
      `deakinsync:page:${input.path}:${input.includeText === true ? "text" : "outline"}`,
      input.refresh,
      laneCall({
        app: "deakinsync",
        operation: "deakinsyncPage",
        tool: "inspect_deakinsync_page",
        refresh: input.refresh,
        args: { path: input.path, includeText: input.includeText === true },
      }).pipe(
        Effect.flatMap((raw) =>
          Effect.map(stamp, ({ iso }) => normalizePortalPage({ raw, fetchedAt: iso })),
        ),
      ),
    );

  const signIn: CampusService["Service"]["signIn"] = (input) =>
    Effect.gen(function* () {
      const lane = laneOf(input.app);
      yield* laneCall({
        app: input.app,
        operation: "signIn",
        tool: lane === "deakin" ? "login_in_browser" : "microsoft_login_in_browser",
        args: {},
        timeoutMs: SIGN_IN_TIMEOUT_MS,
      });
      signInMissing.delete(lane);
      // A sign-in changes what every page of that lane may read.
      for (const key of kept.keys()) {
        if (
          key.startsWith(lane === "deakin" ? "ontrack:" : "teams:") ||
          key.startsWith(lane === "deakin" ? "deakinsync:" : "outlook:")
        ) {
          kept.delete(key);
        }
      }
      const current = yield* status;
      const app = current.apps.find((candidate) => candidate.app === input.app);
      return { signedIn: app?.signedIn ?? false, detail: app?.detail ?? null };
    });

  return CampusService.of({
    status,
    ontrackOverview,
    ontrackTask,
    outlookInbox,
    outlookEmail,
    outlookCalendar,
    teamsThreads,
    teamsThread,
    deakinsyncPage,
    signIn,
  });
});

export const layer = Layer.effect(CampusService, make);
