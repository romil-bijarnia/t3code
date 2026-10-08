import type { EnvironmentId, OnTrackTask, OnTrackUnit } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import type { PinnedApp } from "../pinnedApps/pinnedApps";
import { CampusPage } from "./CampusPage";
import {
  TONE_DOT,
  daysUntil,
  dueLabel,
  formatShortDate,
  isOverdue,
  issueFromQueryError,
  ontrackStatus,
  sortTasks,
  useLastDefined,
} from "./campus";

const GRADE_NAMES = ["Pass", "Credit", "Distinction", "High Distinction"] as const;

/** OnTrack as a page: every current unit with its tasks, their state and what is due. */
export function OnTrackPage({ app }: { readonly app: PinnedApp }) {
  const environmentId = usePrimaryEnvironmentId();
  const [force, setForce] = useState(false);
  const query = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.campusOntrackOverview({
          environmentId,
          input: force ? { refresh: true } : {},
        })
      : null,
  );
  const data = useLastDefined(query.data);
  // The lane's on-disk copy paints first; the live read follows on its own.
  if (data?.meta.stale && data.meta.issue === null && !force) setForce(true);
  const issue =
    issueFromQueryError(query.error) ??
    (data?.meta.issue ? { reason: data.meta.issue, detail: data.meta.note ?? "" } : null);
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const tasksByUnit = useMemo(() => {
    const groups = new Map<number, OnTrackTask[]>();
    for (const task of data?.tasks ?? []) {
      groups.set(task.projectId, [...(groups.get(task.projectId) ?? []), task]);
    }
    return new Map([...groups].map(([projectId, tasks]) => [projectId, sortTasks(tasks)]));
  }, [data?.tasks]);

  return (
    <CampusPage
      app={app}
      environmentId={environmentId}
      meta={data?.meta ?? null}
      issue={issue}
      loading={query.isPending}
      onRefresh={() => (force ? query.refresh() : setForce(true))}
    >
      {data ? (
        <>
          <OnTrackSummary tasks={data.tasks} />
          {data.units.map((unit) => (
            <UnitSection
              key={unit.projectId}
              unit={unit}
              tasks={tasksByUnit.get(unit.projectId) ?? []}
              openTaskId={openTaskId}
              onToggle={(taskId) => setOpenTaskId((open) => (open === taskId ? null : taskId))}
              environmentId={environmentId}
            />
          ))}
          {data.units.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No current units.</p>
          ) : null}
        </>
      ) : null}
    </CampusPage>
  );
}

function OnTrackSummary({ tasks }: { readonly tasks: ReadonlyArray<OnTrackTask> }) {
  const open = tasks.filter((task) => task.status !== "complete");
  const dueSoon = open.filter((task) => {
    const days = daysUntil(task.dueDate ?? task.targetDate);
    return days !== null && days >= 0 && days <= 7;
  });
  const overdue = open.filter((task) => isOverdue(task));
  const waiting = open.filter(
    (task) => task.status === "ready_for_feedback" || task.status === "ready_to_mark",
  );
  const toFix = open.filter((task) => task.status === "fix_and_resubmit" || task.status === "redo");
  const parts = [
    `${open.length} open`,
    ...(overdue.length > 0 ? [`${overdue.length} overdue`] : []),
    ...(dueSoon.length > 0 ? [`${dueSoon.length} due this week`] : []),
    ...(waiting.length > 0 ? [`${waiting.length} waiting on marking`] : []),
    ...(toFix.length > 0 ? [`${toFix.length} to fix`] : []),
    `${tasks.length - open.length} complete`,
  ];
  return <p className="pt-2 text-sm text-muted-foreground">{parts.join(" · ")}</p>;
}

function UnitSection({
  unit,
  tasks,
  openTaskId,
  onToggle,
  environmentId,
}: {
  readonly unit: OnTrackUnit;
  readonly tasks: ReadonlyArray<OnTrackTask>;
  readonly openTaskId: number | null;
  readonly onToggle: (taskId: number) => void;
  readonly environmentId: EnvironmentId | null;
}) {
  return (
    <section className="pt-8">
      <div className="flex items-baseline gap-2 pb-2">
        <h2 className="text-lg text-foreground">{unit.unitCode}</h2>
        <span className="min-w-0 truncate text-sm text-muted-foreground">{unit.unitName}</span>
      </div>
      <div role="list" className="flex flex-col gap-0.5">
        {tasks.map((task) => (
          <TaskRow
            key={task.taskId}
            task={task}
            open={openTaskId === task.taskId}
            onToggle={() => onToggle(task.taskId)}
            environmentId={environmentId}
          />
        ))}
        {tasks.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">No tasks.</p>
        ) : null}
      </div>
    </section>
  );
}

function TaskRow({
  task,
  open,
  onToggle,
  environmentId,
}: {
  readonly task: OnTrackTask;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly environmentId: EnvironmentId | null;
}) {
  const status = ontrackStatus(task.status);
  const due = dueLabel(task);
  const overdue = isOverdue(task);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div role="listitem">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="flex min-w-0 cursor-default items-center gap-3 rounded-lg px-2 py-2 leading-6 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onToggle}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onToggle();
        }}
      >
        <Chevron className="size-4 shrink-0 text-muted-foreground" />
        <span className="w-16 shrink-0 truncate text-sm text-muted-foreground tabular-nums">
          {task.taskAbbreviation}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">{task.taskName}</span>
        {task.newComments > 0 ? (
          <span className="shrink-0 rounded-full bg-(--codex-accent) px-1.5 text-xs leading-5 text-white">
            {task.newComments}
          </span>
        ) : null}
        <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
          <span className={cn("size-2 rounded-full", TONE_DOT[status.tone])} />
          {status.label}
        </span>
        <span
          className={cn(
            "w-28 shrink-0 text-right text-sm",
            overdue ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {due}
        </span>
      </div>
      {open ? <TaskDetail task={task} environmentId={environmentId} /> : null}
    </div>
  );
}

function TaskDetail({
  task,
  environmentId,
}: {
  readonly task: OnTrackTask;
  readonly environmentId: EnvironmentId | null;
}) {
  const query = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.campusOntrackTask({
          environmentId,
          input: {
            projectId: task.projectId,
            taskId: task.taskId,
            taskAbbreviation: task.taskAbbreviation,
          },
        })
      : null,
  );
  const details = query.data;
  return (
    <div className="mt-1 mb-2 ml-9 space-y-4 rounded-2xl border border-border px-4 py-4 text-sm">
      {query.error ? <p className="text-muted-foreground">{query.error}</p> : null}
      {!details && !query.error ? (
        <p className="text-muted-foreground" role="status">
          Reading the task…
        </p>
      ) : null}
      {details ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
            {details.targetGrade !== null ? (
              <>
                <dt>Target</dt>
                <dd className="text-foreground">
                  {GRADE_NAMES[details.targetGrade] ?? String(details.targetGrade)}
                </dd>
              </>
            ) : null}
            {task.dueDate ? (
              <>
                <dt>Due</dt>
                <dd className="text-foreground">{formatShortDate(task.dueDate)}</dd>
              </>
            ) : null}
            {task.targetDate ? (
              <>
                <dt>Target date</dt>
                <dd className="text-foreground">{formatShortDate(task.targetDate)}</dd>
              </>
            ) : null}
            {details.submission?.submissionDate ? (
              <>
                <dt>Submitted</dt>
                <dd className="text-foreground">
                  {formatShortDate(details.submission.submissionDate)}
                  {details.submission.hasPdf ? " · PDF attached" : ""}
                </dd>
              </>
            ) : null}
            {task.extensions > 0 ? (
              <>
                <dt>Extensions</dt>
                <dd className="text-foreground">{task.extensions}</dd>
              </>
            ) : null}
            {task.uploadRequirements.length > 0 ? (
              <>
                <dt>Upload</dt>
                <dd className="text-foreground">
                  {task.uploadRequirements.map((requirement) => requirement.name).join(", ")}
                </dd>
              </>
            ) : null}
          </dl>
          {details.description ? (
            <p className="whitespace-pre-wrap text-foreground/90">{details.description}</p>
          ) : null}
          {details.comments.length > 0 ? (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">Comments</div>
              {details.comments.map((comment) => (
                <div key={comment.commentId} className="space-y-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-foreground">{comment.author ?? "OnTrack"}</span>
                    {comment.createdAt ? (
                      <span className="text-xs text-muted-foreground">
                        {comment.createdAt.slice(0, 10)}
                      </span>
                    ) : null}
                    {comment.isNew ? (
                      <span className="text-xs text-(--codex-accent)">New</span>
                    ) : null}
                  </div>
                  <p className="whitespace-pre-wrap text-foreground/90">
                    {comment.text ?? (comment.status ? ontrackStatus(comment.status).label : "")}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
