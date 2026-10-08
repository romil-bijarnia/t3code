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

/**
 * Pure shaping of what the browser lane's tools return into the campus
 * contracts. The lane's JSON is loosely typed and changes with the portals'
 * DOM, so every field is read defensively and missing text becomes null.
 */

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : {};
const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean => value === true;

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
  };
}

export function normalizeOnTrackOverview(input: {
  readonly units: unknown;
  readonly tasks: unknown;
  readonly fetchedAt: string;
}): CampusOnTrackOverviewResult {
  const units = asArray(asRecord(input.units).units).flatMap((unit) => {
    const normalized = normalizeOnTrackUnit(unit);
    return normalized ? [normalized] : [];
  });
  const tasks = asArray(asRecord(input.tasks).tasks).flatMap((task) => {
    const normalized = normalizeOnTrackTask(task);
    return normalized ? [normalized] : [];
  });
  const unitsMeta = cacheMeta(input.units, input.fetchedAt);
  const tasksMeta = cacheMeta(input.tasks, input.fetchedAt);
  return {
    units,
    tasks,
    meta: tasksMeta.stale ? tasksMeta : unitsMeta,
  };
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

function normalizeOutlookMessage(raw: unknown): OutlookMessage {
  const message = asRecord(raw);
  return {
    ref: text(message.ref),
    sender: text(message.sender),
    subject: text(message.subject),
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
    messages: asArray(envelope.messages ?? envelope.items).map(normalizeOutlookMessage),
    meta: meta({ fetchedAt: input.fetchedAt }),
  };
}

export function normalizeOutlookEmail(input: {
  readonly raw: unknown;
  readonly fetchedAt: string;
}): CampusOutlookEmailResult {
  const envelope = asRecord(input.raw);
  return {
    messages: asArray(envelope.items ?? envelope.messages).map(normalizeOutlookMessage),
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
