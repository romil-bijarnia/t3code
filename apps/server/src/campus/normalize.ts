import {
  campusIssueFromMessage,
  type CampusDeakinSyncPageResult,
  CampusErrorReason,
  CampusFetchMeta,
  CampusOnTrackOverviewResult,
  CampusOnTrackTaskResult,
  CampusOutlookCalendarResult,
  CampusOutlookEmailResult,
  CampusOutlookInboxResult,
  CampusTeamsThreadResult,
  CampusTeamsThreadsResult,
  OnTrackComment,
  OnTrackTask,
  OnTrackUnit,
  OutlookMessage,
  TeamsMessage,
  TeamsThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Pure shaping of what the browser lane's tools return into the campus
 * contracts. The lane's JSON is loosely typed and changes with the portals'
 * DOM, so every field is read defensively and missing text becomes null.
 */

type Raw = Record<string, unknown>;

export const asRecord = (value: unknown): Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : {};
export const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
export const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const bool = (value: unknown): boolean => value === true;
/** Milliseconds for an ISO date or date-time string, or null when it is not one. */
const epochOf = (value: unknown): number | null =>
  typeof value === "string"
    ? Option.getOrNull(Option.map(DateTime.make(value), DateTime.toEpochMillis))
    : null;

export function meta(input: {
  readonly fetchedAt: string;
  readonly stale?: boolean;
  readonly note?: string | null;
  readonly issue?: CampusErrorReason | null;
}): CampusFetchMeta {
  return {
    fetchedAt: input.fetchedAt,
    stale: input.stale ?? false,
    note: input.note ?? null,
    issue: input.issue ?? null,
  };
}

/** The lane's cache block, when it answered from a kept copy. */
export function cacheMeta(raw: unknown, fetchedAt: string): CampusFetchMeta {
  const cache = asRecord(asRecord(raw).cache);
  if (cache.cached !== true) return meta({ fetchedAt });
  const liveError = text(cache.liveError);
  return meta({
    fetchedAt: str(cache.cachedAt, fetchedAt),
    stale: true,
    note: liveError ?? "Showing the last copy; the live read did not go through.",
    issue: liveError ? classifyLaneFailure(liveError) : "tool_failed",
  });
}

export const classifyLaneFailure = campusIssueFromMessage;

/** First sentence of a lane message, bounded so it reads as a status line. */
export function laneDetail(message: string, limit = 240): string {
  const firstLine = message.split(/\r?\n/)[0]?.trim() ?? "";
  return firstLine.length > limit ? `${firstLine.slice(0, limit - 1)}…` : firstLine;
}

export function normalizeOnTrackUnit(raw: unknown): OnTrackUnit | null {
  const unit = asRecord(raw);
  if (typeof unit.projectId !== "number" || typeof unit.unitCode !== "string") return null;
  return {
    projectId: unit.projectId,
    unitCode: unit.unitCode,
    unitName: str(unit.unitName, unit.unitCode),
    teachingPeriod: text(unit.teachingPeriod),
    startDate: text(unit.startDate),
    endDate: text(unit.endDate),
    isCurrent: unit.isCurrent !== false,
    targetGrade: numOrNull(unit.targetGrade),
    submittedGrade: numOrNull(unit.submittedGrade),
  };
}

export function normalizeOnTrackTask(raw: unknown): OnTrackTask | null {
  const task = asRecord(raw);
  if (typeof task.projectId !== "number" || typeof task.taskId !== "number") return null;
  return {
    projectId: task.projectId,
    taskId: task.taskId,
    taskDefinitionId: num(task.taskDefinitionId, task.taskId),
    unitCode: str(task.unitCode),
    taskAbbreviation: str(task.taskAbbreviation),
    taskName: str(task.taskName, str(task.taskAbbreviation)),
    status: str(task.status, "not_started"),
    dueDate: text(task.dueDate) ?? text(task.taskDefinitionDueDate),
    targetDate: text(task.taskTargetDate),
    startDate: text(task.taskStartDate),
    submissionDate: text(task.submissionDate),
    completionDate: text(task.completionDate),
    extensions: num(task.extensions),
    timesAssessed: num(task.timesAssessed),
    newComments: num(task.newComments),
    hasTaskSheet: bool(task.hasTaskSheet),
    hasTaskResources: bool(task.hasTaskResources),
    uploadRequirements: asArray(task.uploadRequirements).flatMap((entry) => {
      const requirement = asRecord(entry);
      return typeof requirement.name === "string"
        ? [{ name: requirement.name, type: str(requirement.type, "document") }]
        : [];
    }),
    targetGrade:
      numOrNull(task.taskTargetGrade) ?? numOrNull(asRecord(task.taskDefinition).targetGrade),
    weighting: numOrNull(asRecord(task.taskDefinition).weighting),
  };
}

/** The lane's project-details answer, with or without its `payload` wrapper. */
function projectDetailsOf(raw: unknown): Raw {
  const envelope = asRecord(raw);
  return "payload" in envelope ? asRecord(envelope.payload) : envelope;
}

/**
 * The overview joins the unit list with each unit's project details, which
 * carry the grade target and every task's tier and weighting. A unit whose
 * details are missing keeps its row with the grade fields empty.
 */
export function normalizeOnTrackOverview(input: {
  readonly units: unknown;
  readonly projects: ReadonlyArray<unknown>;
  readonly fetchedAt: string;
}): CampusOnTrackOverviewResult {
  const detailsByProject = new Map(
    input.projects.flatMap((raw) => {
      const details = projectDetailsOf(raw);
      const projectId = asRecord(details.project).projectId;
      return typeof projectId === "number" ? [[projectId, details] as const] : [];
    }),
  );
  const units = asArray(asRecord(input.units).units).flatMap((rawUnit) => {
    const unit = normalizeOnTrackUnit(rawUnit);
    if (!unit) return [];
    const project = asRecord(detailsByProject.get(unit.projectId)?.project);
    return [
      {
        ...unit,
        targetGrade: numOrNull(project.targetGrade),
        submittedGrade: numOrNull(project.submittedGrade),
      },
    ];
  });
  const tasks = [...detailsByProject.values()].flatMap((details) =>
    asArray(details.tasks).flatMap((task) => {
      const normalized = normalizeOnTrackTask(task);
      return normalized ? [normalized] : [];
    }),
  );
  const staleProject = input.projects
    .map((raw) => cacheMeta(raw, input.fetchedAt))
    .find((candidate) => candidate.stale);
  const unitsMeta = cacheMeta(input.units, input.fetchedAt);
  return { units, tasks, meta: staleProject ?? unitsMeta };
}

function normalizeComment(raw: unknown): OnTrackComment | null {
  const comment = asRecord(raw);
  if (typeof comment.commentId !== "number") return null;
  const author = asRecord(comment.author);
  return {
    commentId: comment.commentId,
    type: str(comment.type, "text"),
    status: text(comment.status),
    text: text(comment.text),
    createdAt: text(comment.createdAt),
    isNew: bool(comment.isNew),
    author: text(author.name) ?? text(author.firstName) ?? text(comment.authorName),
    hasAttachment: bool(comment.hasAttachment),
  };
}

export function normalizeOnTrackTaskDetails(input: {
  readonly raw: unknown;
  readonly fetchedAt: string;
}): CampusOnTrackTaskResult | null {
  const envelope = asRecord(input.raw);
  const payload = asRecord("payload" in envelope ? envelope.payload : envelope);
  const task = normalizeOnTrackTask(payload.task);
  if (!task) return null;
  const definition = asRecord(payload.taskDefinition);
  const submission = asRecord(payload.submission);
  return {
    task,
    description: text(definition.description) ?? text(asRecord(payload.task).taskDescription),
    targetGrade:
      numOrNull(definition.targetGrade) ?? numOrNull(asRecord(payload.task).taskTargetGrade),
    weighting: numOrNull(definition.weighting),
    submission:
      Object.keys(submission).length > 0
        ? {
            submissionDate: text(submission.submissionDate),
            status: text(submission.taskStatus),
            hasPdf: bool(submission.hasPdf),
          }
        : null,
    comments: asArray(payload.comments).flatMap((comment) => {
      const normalized = normalizeComment(comment);
      return normalized ? [normalized] : [];
    }),
    taskPagePath: text(payload.taskPagePath),
    meta: cacheMeta(input.raw, input.fetchedAt),
  };
}

function normalizeOutlookMessage(raw: unknown, subject: string | null = null): OutlookMessage {
  const message = asRecord(raw);
  return {
    ref: text(message.ref),
    sender: text(message.sender) ?? text(message.senderAddress),
    subject: text(message.subject) ?? subject,
    receivedAt: text(message.receivedAt) ?? text(message.timestamp),
    preview: text(message.preview),
    body: text(message.body),
    unread: bool(message.unread),
    hasAttachments: bool(message.hasAttachments),
    href: text(message.href),
  };
}

export function normalizeOutlookInbox(input: {
  readonly raw: unknown;
  readonly fetchedAt: string;
}): CampusOutlookInboxResult {
  const envelope = asRecord(input.raw);
  return {
    messages: asArray(envelope.messages ?? envelope.items).map((item) =>
      normalizeOutlookMessage(item),
    ),
    meta: meta({ fetchedAt: input.fetchedAt }),
  };
}

export function normalizeOutlookEmail(input: {
  readonly raw: unknown;
  readonly fetchedAt: string;
}): CampusOutlookEmailResult {
  const envelope = asRecord(input.raw);
  const subject = text(envelope.subject);
  return {
    messages: asArray(envelope.items ?? envelope.messages).map((item) =>
      normalizeOutlookMessage(item, subject),
    ),
    meta: meta({ fetchedAt: input.fetchedAt }),
  };
}

export function normalizeOutlookCalendar(input: {
  readonly raw: unknown;
  readonly fetchedAt: string;
}): CampusOutlookCalendarResult {
  const envelope = asRecord(input.raw);
  return {
    events: asArray(envelope.events ?? envelope.items).map((entry) => {
      const event = asRecord(entry);
      return { title: text(event.title), detail: text(event.detail) };
    }),
    meta: meta({ fetchedAt: input.fetchedAt }),
  };
}

function normalizeTeamsThreadRow(raw: unknown): TeamsThread {
  const thread = asRecord(raw);
  return {
    ref: text(thread.ref),
    title: text(thread.title),
    preview: text(thread.preview),
    timestamp: text(thread.timestamp),
    unread: bool(thread.unread),
    href: text(thread.href),
  };
}

export function normalizeTeamsThreads(input: {
  readonly raw: unknown;
  readonly fetchedAt: string;
}): CampusTeamsThreadsResult {
  const envelope = asRecord(input.raw);
  const pagination = asRecord(envelope.pagination);
  return {
    threads: asArray(envelope.threads ?? envelope.items).map(normalizeTeamsThreadRow),
    nextCursor: text(pagination.nextCursor),
    meta: meta({ fetchedAt: input.fetchedAt }),
  };
}

function normalizeTeamsMessage(raw: unknown): TeamsMessage {
  const message = asRecord(raw);
  return {
    ref: text(message.ref),
    sender: text(message.sender),
    sentAt: text(message.sentAt) ?? text(message.timestamp),
    body: text(message.body),
    preview: text(message.preview),
    replyCount: num(message.replyCount),
    isReply: bool(message.isReply),
    href: text(message.href),
  };
}

export function normalizeTeamsThread(input: {
  readonly raw: unknown;
  readonly fetchedAt: string;
}): CampusTeamsThreadResult {
  const envelope = asRecord(input.raw);
  const selection = asRecord(envelope.selection);
  const pagination = asRecord(envelope.pagination);
  return {
    title: text(selection.title) ?? text(asRecord(selection.requested).title),
    messages: asArray(envelope.items ?? envelope.messages).map(normalizeTeamsMessage),
    nextCursor: text(pagination.nextCursor),
    meta: meta({ fetchedAt: input.fetchedAt }),
  };
}

export function normalizePortalPage(input: {
  readonly raw: unknown;
  readonly fetchedAt: string;
}): CampusDeakinSyncPageResult {
  const page = asRecord(input.raw);
  return {
    title: text(page.title),
    location: text(page.location),
    headings: asArray(page.headings).flatMap((entry) => {
      const heading = asRecord(entry);
      return typeof heading.text === "string"
        ? [{ level: num(heading.level, 2), text: heading.text }]
        : [];
    }),
    links: asArray(page.links).flatMap((entry) => {
      const link = asRecord(entry);
      return typeof link.href === "string"
        ? [{ text: text(link.text), href: link.href, downloadLike: bool(link.downloadLike) }]
        : [];
    }),
    text: text(page.textSnippet),
    meta: meta({ fetchedAt: input.fetchedAt }),
  };
}

/** Per-portal sign-in from the Deakin lane's `session_status` answer. */
export function deakinSignIn(raw: unknown): { ontrack: boolean; deakinsync: boolean } {
  const portals = asRecord(asRecord(raw).portals);
  return {
    ontrack: bool(asRecord(portals.ontrack).authenticated),
    deakinsync: bool(asRecord(portals.deakinsync).authenticated),
  };
}

/**
 * The Microsoft lane reports a partial session as an error naming what is
 * missing ("Missing: mail, calendar"), so Teams can be signed in while
 * Outlook is not.
 */
export function microsoftSignIn(input: { readonly ok: boolean; readonly message: string | null }): {
  teams: boolean;
  outlook: boolean;
} {
  if (input.ok) return { teams: true, outlook: true };
  const missing = /Missing:\s*([^.]*)/i.exec(input.message ?? "")?.[1] ?? "";
  if (!missing) return { teams: false, outlook: false };
  const parts = new Set(missing.split(",").map((part) => part.trim().toLowerCase()));
  return {
    teams: !parts.has("teams"),
    outlook: !parts.has("mail") && !parts.has("calendar"),
  };
}

/** A task row of OnTrack's API joined with its unit's task definition. */
function normalizeApiTask(input: {
  readonly task: Raw;
  readonly definition: Raw;
  readonly projectId: number;
  readonly unitCode: string;
}): OnTrackTask | null {
  const { task, definition } = input;
  if (typeof task.id !== "number") return null;
  return {
    projectId: input.projectId,
    taskId: task.id,
    taskDefinitionId: num(task.task_definition_id, num(definition.id)),
    unitCode: input.unitCode,
    taskAbbreviation: str(definition.abbreviation).trim(),
    taskName: str(definition.name, str(definition.abbreviation)).trim(),
    status: str(task.status, "not_started"),
    dueDate: text(task.due_date) ?? text(definition.due_date),
    targetDate: text(definition.target_date),
    startDate: text(definition.start_date),
    submissionDate: text(task.submission_date),
    completionDate: text(task.completion_date),
    extensions: num(task.extensions),
    timesAssessed: num(task.times_assessed),
    newComments: num(task.num_new_comments),
    hasTaskSheet: bool(definition.has_task_sheet),
    hasTaskResources: bool(definition.has_task_resources),
    uploadRequirements: asArray(definition.upload_requirements).flatMap((entry) => {
      const requirement = asRecord(entry);
      return typeof requirement.name === "string"
        ? [{ name: requirement.name, type: str(requirement.type, "document") }]
        : [];
    }),
    targetGrade: numOrNull(definition.target_grade),
    weighting: numOrNull(definition.weighting),
  };
}

const DAY_MS = 86_400_000;

const periodsById = (periods: unknown) =>
  new Map(
    asArray(periods).flatMap((entry) => {
      const period = asRecord(entry);
      return typeof period.id === "number" ? [[period.id, period] as const] : [];
    }),
  );

interface TrimesterWindow {
  readonly start: number | null;
  /** The last day marking still counts: the period's `active_until` when it has one. */
  readonly end: number | null;
}

/** When a unit runs, from its own dates with the teaching period filling gaps. */
const trimesterWindow = (unit: Raw, period: Raw | undefined): TrimesterWindow => ({
  start: epochOf(unit.start_date) ?? epochOf(period?.start_date),
  end: epochOf(period?.active_until) ?? epochOf(unit.end_date) ?? epochOf(period?.end_date),
});

const withinTrimester = ({ start, end }: TrimesterWindow, nowMs: number): boolean =>
  start !== null && end !== null && start <= nowMs && nowMs <= end + DAY_MS;

/**
 * Which of the person's projects belong to the trimester under way. OnTrack's
 * `active` flag stays on for years, so the unit's dates decide, extended by the
 * period's `active_until` so marking weeks still count. Between trimesters the
 * most recently finished units stand in, so the dashboard never goes blank.
 */
export function currentProjects(
  list: unknown,
  periods: unknown,
  nowMs: number,
): Array<{ readonly projectId: number; readonly unitId: number }> {
  const byId = periodsById(periods);
  const candidates = asArray(list).flatMap((entry) => {
    const project = asRecord(entry);
    const unit = asRecord(project.unit);
    if (typeof project.id !== "number") return [];
    const window = trimesterWindow(unit, byId.get(num(unit.teaching_period_id, -1)));
    return [
      {
        projectId: project.id,
        unitId: num(unit.id, num(project.unit_id, -1)),
        window,
      },
    ];
  });
  const strip = ({ projectId, unitId }: (typeof candidates)[number]) => ({ projectId, unitId });
  const current = candidates.filter(({ window }) => withinTrimester(window, nowMs));
  if (current.length > 0) return current.map(strip);
  const finished = candidates.filter(({ window }) => window.end !== null && window.end <= nowMs);
  const latestEnd = Math.max(...finished.map(({ window }) => window.end ?? 0));
  return (
    finished.length > 0 ? finished.filter(({ window }) => window.end === latestEnd) : candidates
  ).map(strip);
}

/**
 * The overview straight from OnTrack's API: each current project with its
 * unit (which holds the task definitions) and the teaching periods for the
 * period label and dates.
 */
export function normalizeOnTrackApiOverview(input: {
  readonly projects: ReadonlyArray<{ readonly project: unknown; readonly unit: unknown }>;
  readonly periods: unknown;
  readonly fetchedAt: string;
}): CampusOnTrackOverviewResult {
  const periods = periodsById(input.periods);
  const nowMs = epochOf(input.fetchedAt) ?? 0;
  const units: OnTrackUnit[] = [];
  const tasks: OnTrackTask[] = [];
  for (const entry of input.projects) {
    const project = asRecord(entry.project);
    const unit = asRecord(entry.unit);
    const projectUnit = asRecord(project.unit);
    if (typeof project.id !== "number") continue;
    const unitCode = str(unit.code, str(projectUnit.code));
    const period = periods.get(num(projectUnit.teaching_period_id, num(unit.teaching_period_id)));
    units.push({
      projectId: project.id,
      unitCode,
      unitName: str(unit.name, str(projectUnit.name, unitCode)),
      teachingPeriod: period
        ? `${str(period.period)} ${typeof period.year === "number" ? period.year : str(period.year)}`.trim()
        : null,
      startDate: text(period?.start_date) ?? text(unit.start_date) ?? text(projectUnit.start_date),
      endDate: text(period?.end_date) ?? text(unit.end_date) ?? text(projectUnit.end_date),
      isCurrent: withinTrimester(
        trimesterWindow(Object.keys(unit).length > 0 ? unit : projectUnit, period),
        nowMs,
      ),
      targetGrade: numOrNull(project.target_grade),
      submittedGrade: numOrNull(project.submitted_grade),
    });
    const definitions = new Map(
      asArray(unit.task_definitions).flatMap((definition) => {
        const record = asRecord(definition);
        return typeof record.id === "number" ? [[record.id, record] as const] : [];
      }),
    );
    for (const rawTask of asArray(project.tasks)) {
      const task = asRecord(rawTask);
      const definition = definitions.get(num(task.task_definition_id, -1)) ?? {};
      const normalized = normalizeApiTask({ task, definition, projectId: project.id, unitCode });
      if (normalized) tasks.push(normalized);
    }
  }
  return { units, tasks, meta: meta({ fetchedAt: input.fetchedAt }) };
}

/** One task's details from OnTrack's API: its row, definition, comments and submission. */
export function normalizeOnTrackApiTask(input: {
  readonly task: OnTrackTask;
  readonly definition: unknown;
  readonly comments: unknown;
  readonly submission: unknown;
  readonly fetchedAt: string;
}): CampusOnTrackTaskResult {
  const definition = asRecord(input.definition);
  const submission = asRecord(input.submission);
  return {
    task: input.task,
    description: text(definition.description),
    targetGrade: numOrNull(definition.target_grade) ?? input.task.targetGrade,
    weighting: numOrNull(definition.weighting) ?? input.task.weighting,
    submission:
      Object.keys(submission).length > 0
        ? {
            submissionDate: text(submission.submission_date),
            status: text(submission.task_status),
            hasPdf: bool(submission.has_pdf),
          }
        : null,
    comments: asArray(input.comments).flatMap((entry) => {
      const comment = asRecord(entry);
      if (typeof comment.id !== "number") return [];
      const author = asRecord(comment.author);
      const name = [text(author.first_name), text(author.last_name)].filter(Boolean).join(" ");
      return [
        {
          commentId: comment.id,
          type: str(comment.type, "text"),
          status: text(comment.status),
          text: text(comment.comment),
          createdAt: text(comment.created_at) ?? text(comment.date),
          isNew: bool(comment.is_new),
          author: name || text(author.email),
          hasAttachment: bool(comment.has_attachment),
        },
      ];
    }),
    taskPagePath: `/projects/${input.task.projectId}/dashboard/${input.task.taskAbbreviation}`,
    meta: meta({ fetchedAt: input.fetchedAt }),
  };
}
