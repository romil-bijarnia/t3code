import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/**
 * The university and Microsoft surfaces the fork shows as native pages:
 * OnTrack tasks, DeakinSync pages, Teams threads and Outlook mail/calendar,
 * read through the local browser lane rather than embedded as websites.
 */
export const CampusApp = Schema.Literals(["ontrack", "deakinsync", "teams", "outlook"]);
export type CampusApp = typeof CampusApp.Type;

export const CampusErrorReason = Schema.Literals([
  "sign_in_required",
  "lane_offline",
  "tool_failed",
  "invalid_input",
]);
export type CampusErrorReason = typeof CampusErrorReason.Type;

/** Sorts a lane's failure line into what a page can do about it; shared by server and clients. */
export function campusIssueFromMessage(message: string): CampusErrorReason {
  if (/broker/i.test(message) && /not running|unavailable|refused|offline/i.test(message)) {
    return "lane_offline";
  }
  if (/sign[ -]?in|session|unauthenticated|login|log in/i.test(message)) {
    return "sign_in_required";
  }
  return "tool_failed";
}

export class CampusError extends Schema.TaggedError<CampusError>()("CampusError", {
  app: CampusApp,
  operation: Schema.String,
  reason: CampusErrorReason,
  /** One bounded sentence from the lane, safe to show; never a payload. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const Text = Schema.NullOr(Schema.String);

/** Where a result came from: fresh from the lane, or a kept copy while it is unavailable. */
export const CampusFetchMeta = Schema.Struct({
  fetchedAt: IsoDateTime,
  stale: Schema.Boolean,
  note: Text,
  /** Why the copy is stale, when the lane refused the fresh read. */
  issue: Schema.NullOr(CampusErrorReason),
});
export type CampusFetchMeta = typeof CampusFetchMeta.Type;

export const CampusAppStatus = Schema.Struct({
  app: CampusApp,
  signedIn: Schema.Boolean,
  detail: Text,
});
export type CampusAppStatus = typeof CampusAppStatus.Type;

export const CampusStatusInput = Schema.Struct({});
export type CampusStatusInput = typeof CampusStatusInput.Type;

export const CampusStatusResult = Schema.Struct({
  laneOnline: Schema.Boolean,
  apps: Schema.Array(CampusAppStatus),
  checkedAt: IsoDateTime,
});
export type CampusStatusResult = typeof CampusStatusResult.Type;

/** OnTrack grade tiers: 0 Pass, 1 Credit, 2 Distinction, 3 High Distinction. */
export const OnTrackGrade = Schema.Number;

export const OnTrackUnit = Schema.Struct({
  projectId: Schema.Number,
  unitCode: Schema.String,
  unitName: Schema.String,
  teachingPeriod: Text,
  startDate: Text,
  endDate: Text,
  isCurrent: Schema.Boolean,
  /** The grade the student is aiming for in this unit, when the unit's details were read. */
  targetGrade: Schema.NullOr(OnTrackGrade),
  submittedGrade: Schema.NullOr(OnTrackGrade),
});
export type OnTrackUnit = typeof OnTrackUnit.Type;

export const OnTrackUploadRequirement = Schema.Struct({ name: Schema.String, type: Schema.String });

export const OnTrackTask = Schema.Struct({
  projectId: Schema.Number,
  taskId: Schema.Number,
  taskDefinitionId: Schema.Number,
  unitCode: Schema.String,
  taskAbbreviation: Schema.String,
  taskName: Schema.String,
  /** OnTrack's own status keys, such as `not_started`, `ready_for_feedback`, `complete`. */
  status: Schema.String,
  dueDate: Text,
  targetDate: Text,
  startDate: Text,
  submissionDate: Text,
  completionDate: Text,
  extensions: Schema.Number,
  timesAssessed: Schema.Number,
  newComments: Schema.Number,
  hasTaskSheet: Schema.Boolean,
  hasTaskResources: Schema.Boolean,
  uploadRequirements: Schema.Array(OnTrackUploadRequirement),
  /** The grade tier this task counts toward, when the unit's details were read. */
  targetGrade: Schema.NullOr(OnTrackGrade),
  weighting: Schema.NullOr(Schema.Number),
});
export type OnTrackTask = typeof OnTrackTask.Type;

export const CampusOnTrackOverviewInput = Schema.Struct({
  refresh: Schema.optional(Schema.Boolean),
});
export type CampusOnTrackOverviewInput = typeof CampusOnTrackOverviewInput.Type;

export const CampusOnTrackOverviewResult = Schema.Struct({
  units: Schema.Array(OnTrackUnit),
  tasks: Schema.Array(OnTrackTask),
  meta: CampusFetchMeta,
});
export type CampusOnTrackOverviewResult = typeof CampusOnTrackOverviewResult.Type;

export const OnTrackComment = Schema.Struct({
  commentId: Schema.Number,
  type: Schema.String,
  status: Text,
  text: Text,
  createdAt: Text,
  isNew: Schema.Boolean,
  author: Text,
  hasAttachment: Schema.Boolean,
});
export type OnTrackComment = typeof OnTrackComment.Type;

export const CampusOnTrackTaskInput = Schema.Struct({
  projectId: Schema.Number,
  taskId: Schema.Number,
  taskDefinitionId: Schema.Number,
  taskAbbreviation: Schema.String,
  refresh: Schema.optional(Schema.Boolean),
});
export type CampusOnTrackTaskInput = typeof CampusOnTrackTaskInput.Type;

export const CampusOnTrackTaskResult = Schema.Struct({
  task: OnTrackTask,
  description: Text,
  targetGrade: Schema.NullOr(Schema.Number),
  weighting: Schema.NullOr(Schema.Number),
  submission: Schema.NullOr(
    Schema.Struct({ submissionDate: Text, status: Text, hasPdf: Schema.Boolean }),
  ),
  comments: Schema.Array(OnTrackComment),
  taskPagePath: Text,
  meta: CampusFetchMeta,
});
export type CampusOnTrackTaskResult = typeof CampusOnTrackTaskResult.Type;

export const OutlookMessage = Schema.Struct({
  ref: Text,
  sender: Text,
  subject: Text,
  receivedAt: Text,
  preview: Text,
  body: Text,
  unread: Schema.Boolean,
  hasAttachments: Schema.Boolean,
  href: Text,
});
export type OutlookMessage = typeof OutlookMessage.Type;

export const CampusListInput = Schema.Struct({
  top: Schema.optional(Schema.Number),
  refresh: Schema.optional(Schema.Boolean),
});
export type CampusListInput = typeof CampusListInput.Type;

export const CampusOutlookInboxResult = Schema.Struct({
  messages: Schema.Array(OutlookMessage),
  meta: CampusFetchMeta,
});
export type CampusOutlookInboxResult = typeof CampusOutlookInboxResult.Type;

/** A conversation opens by the id its inbox row carries. */
export const CampusOutlookEmailInput = Schema.Struct({
  ref: Schema.String,
  refresh: Schema.optional(Schema.Boolean),
});
export type CampusOutlookEmailInput = typeof CampusOutlookEmailInput.Type;

export const CampusOutlookEmailResult = Schema.Struct({
  messages: Schema.Array(OutlookMessage),
  meta: CampusFetchMeta,
});
export type CampusOutlookEmailResult = typeof CampusOutlookEmailResult.Type;

export const OutlookEvent = Schema.Struct({ title: Text, detail: Text });
export type OutlookEvent = typeof OutlookEvent.Type;

export const CampusOutlookCalendarResult = Schema.Struct({
  events: Schema.Array(OutlookEvent),
  meta: CampusFetchMeta,
});
export type CampusOutlookCalendarResult = typeof CampusOutlookCalendarResult.Type;

export const TeamsThread = Schema.Struct({
  ref: Text,
  title: Text,
  preview: Text,
  timestamp: Text,
  unread: Schema.Boolean,
  href: Text,
});
export type TeamsThread = typeof TeamsThread.Type;

export const CampusTeamsThreadsInput = Schema.Struct({
  top: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String),
  refresh: Schema.optional(Schema.Boolean),
});
export type CampusTeamsThreadsInput = typeof CampusTeamsThreadsInput.Type;

export const CampusTeamsThreadsResult = Schema.Struct({
  threads: Schema.Array(TeamsThread),
  nextCursor: Text,
  meta: CampusFetchMeta,
});
export type CampusTeamsThreadsResult = typeof CampusTeamsThreadsResult.Type;

export const TeamsMessage = Schema.Struct({
  ref: Text,
  sender: Text,
  sentAt: Text,
  body: Text,
  preview: Text,
  replyCount: Schema.Number,
  isReply: Schema.Boolean,
  href: Text,
});
export type TeamsMessage = typeof TeamsMessage.Type;

export const CampusTeamsThreadInput = Schema.Struct({
  threadRef: Schema.String,
  cursor: Schema.optional(Schema.String),
  refresh: Schema.optional(Schema.Boolean),
});
export type CampusTeamsThreadInput = typeof CampusTeamsThreadInput.Type;

export const CampusTeamsThreadResult = Schema.Struct({
  title: Text,
  messages: Schema.Array(TeamsMessage),
  nextCursor: Text,
  meta: CampusFetchMeta,
});
export type CampusTeamsThreadResult = typeof CampusTeamsThreadResult.Type;

export const PortalHeading = Schema.Struct({ level: Schema.Number, text: Schema.String });
export type PortalHeading = typeof PortalHeading.Type;

export const PortalLink = Schema.Struct({
  text: Text,
  href: Schema.String,
  downloadLike: Schema.Boolean,
});
export type PortalLink = typeof PortalLink.Type;

export const CampusDeakinSyncPageInput = Schema.Struct({
  path: Schema.String,
  includeText: Schema.optional(Schema.Boolean),
  refresh: Schema.optional(Schema.Boolean),
});
export type CampusDeakinSyncPageInput = typeof CampusDeakinSyncPageInput.Type;

export const CampusDeakinSyncPageResult = Schema.Struct({
  title: Text,
  location: Text,
  headings: Schema.Array(PortalHeading),
  links: Schema.Array(PortalLink),
  text: Text,
  meta: CampusFetchMeta,
});
export type CampusDeakinSyncPageResult = typeof CampusDeakinSyncPageResult.Type;

export const CampusSignInInput = Schema.Struct({ app: CampusApp });
export type CampusSignInInput = typeof CampusSignInInput.Type;

export const CampusSignInResult = Schema.Struct({ signedIn: Schema.Boolean, detail: Text });
export type CampusSignInResult = typeof CampusSignInResult.Type;
