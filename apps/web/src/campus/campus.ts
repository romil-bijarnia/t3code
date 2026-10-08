import type { CampusErrorReason, OnTrackTask } from "@t3tools/contracts";
import { campusIssueFromMessage } from "@t3tools/contracts";
import { useState } from "react";

/**
 * Keeps the last answer on screen while the next read is in flight, so a
 * refresh or a forced live read never blanks a page that already has content.
 */
export function useLastDefined<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

/** A lane problem the page can act on: sign in, wait for the lane, or retry. */
export interface CampusIssue {
  readonly reason: CampusErrorReason;
  readonly detail: string;
}

export function issueFromQueryError(error: string | null): CampusIssue | null {
  if (error === null) return null;
  return { reason: campusIssueFromMessage(error), detail: error };
}

export type StatusTone = "muted" | "info" | "warning" | "success" | "danger";

/** OnTrack's task status keys as the student sees them. */
export const ONTRACK_STATUS: Record<string, { readonly label: string; readonly tone: StatusTone }> =
  {
    not_started: { label: "Not started", tone: "muted" },
    working_on_it: { label: "Working on it", tone: "info" },
    need_help: { label: "Need help", tone: "warning" },
    ready_for_feedback: { label: "Ready for feedback", tone: "info" },
    ready_to_mark: { label: "Ready for feedback", tone: "info" },
    discuss: { label: "Discuss", tone: "warning" },
    demonstrate: { label: "Demonstrate", tone: "warning" },
    complete: { label: "Complete", tone: "success" },
    fix_and_resubmit: { label: "Fix and resubmit", tone: "danger" },
    feedback_exceeded: { label: "Feedback exceeded", tone: "danger" },
    redo: { label: "Redo", tone: "danger" },
    fail: { label: "Fail", tone: "danger" },
    time_exceeded: { label: "Time exceeded", tone: "danger" },
    do_not_resubmit: { label: "Do not resubmit", tone: "danger" },
  };

export function ontrackStatus(status: string): {
  readonly label: string;
  readonly tone: StatusTone;
} {
  return (
    ONTRACK_STATUS[status] ?? {
      label: status.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase()),
      tone: "muted",
    }
  );
}

export const TONE_DOT: Record<StatusTone, string> = {
  muted: "bg-muted-foreground/50",
  info: "bg-(--codex-accent)",
  warning: "bg-warning",
  success: "bg-success",
  danger: "bg-destructive",
};

const DAY_MS = 86_400_000;

/** Whole days from today to a `YYYY-MM-DD` date in local time; null when unparseable. */
export function daysUntil(date: string | null, now = new Date()): number | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / DAY_MS);
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** "Due today", "Due in 3 days", "Due 18 Sep", "3 days overdue". */
export function dueLabel(task: OnTrackTask, now = new Date()): string | null {
  const date = task.dueDate ?? task.targetDate;
  const days = daysUntil(date, now);
  if (date === null || days === null) return null;
  if (task.status === "complete") return `Done ${formatShortDate(task.completionDate ?? date)}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days <= 7) return `Due in ${days} days`;
  return `Due ${formatShortDate(date)}`;
}

export function formatShortDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date;
  return SHORT_DATE.format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function isOverdue(task: OnTrackTask, now = new Date()): boolean {
  if (task.status === "complete") return false;
  const days = daysUntil(task.dueDate ?? task.targetDate, now);
  return days !== null && days < 0;
}

/** Open work first, soonest due first; finished tasks sink to the end in the order they were done. */
export function sortTasks(tasks: ReadonlyArray<OnTrackTask>): OnTrackTask[] {
  return [...tasks].sort((left, right) => {
    const leftDone = left.status === "complete" ? 1 : 0;
    const rightDone = right.status === "complete" ? 1 : 0;
    if (leftDone !== rightDone) return leftDone - rightDone;
    const leftDue = left.dueDate ?? left.targetDate ?? "";
    const rightDue = right.dueDate ?? right.targetDate ?? "";
    return (
      leftDue.localeCompare(rightDue) || left.taskAbbreviation.localeCompare(right.taskAbbreviation)
    );
  });
}

/** "Updated just now", "Updated 4 min ago", "Updated 2 h ago". */
export function updatedLabel(fetchedAt: string, now = Date.now()): string {
  const diffMs = now - Date.parse(fetchedAt);
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return "Updated just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} h ago`;
  return `Updated ${Math.floor(hours / 24)} d ago`;
}

/** Pairs rows with keys built from their content, numbering repeats so lists stay stable. */
export function withStableKeys<T>(
  rows: ReadonlyArray<T>,
  keyOf: (row: T) => string,
): Array<[string, T]> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = keyOf(row);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return [count === 0 ? base : `${base}#${count}`, row];
  });
}

/** OnTrack grade tiers in the order the ladder is climbed. */
export const GRADE_TIERS = [
  { grade: 0, short: "P", name: "Pass" },
  { grade: 1, short: "C", name: "Credit" },
  { grade: 2, short: "D", name: "Distinction" },
  { grade: 3, short: "HD", name: "High Distinction" },
] as const;

export function gradeName(grade: number | null): string | null {
  return GRADE_TIERS.find((tier) => tier.grade === grade)?.name ?? null;
}

/** Tasks a unit needs for its target grade, and how many of them are done. */
export function targetProgress(
  tasks: ReadonlyArray<OnTrackTask>,
  targetGrade: number | null,
): { readonly done: number; readonly needed: number } {
  const needed = tasks.filter(
    (task) => targetGrade === null || task.targetGrade === null || task.targetGrade <= targetGrade,
  );
  return {
    done: needed.filter((task) => task.status === "complete").length,
    needed: needed.length,
  };
}

/** Open tasks that OnTrack is waiting on the student for, soonest first. */
export const NEEDS_YOU_STATUSES = new Set([
  "fix_and_resubmit",
  "redo",
  "discuss",
  "demonstrate",
  "need_help",
  "time_exceeded",
  "feedback_exceeded",
  "do_not_resubmit",
]);

export function needsYou(task: OnTrackTask, now = new Date()): boolean {
  if (task.status === "complete") return false;
  return NEEDS_YOU_STATUSES.has(task.status) || isOverdue(task, now);
}

export function isWaitingOnMarking(task: OnTrackTask): boolean {
  return task.status === "ready_for_feedback" || task.status === "ready_to_mark";
}
