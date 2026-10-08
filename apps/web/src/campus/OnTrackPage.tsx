import type { EnvironmentId, OnTrackTask, OnTrackUnit } from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { Button } from "../components/ui/button";
import type { PinnedApp } from "../pinnedApps/pinnedApps";
import { CampusPage } from "./CampusPage";
import {
  GRADE_TIERS,
  TONE_DOT,
  daysUntil,
  dueLabel,
  formatShortDate,
  gradeName,
  isOverdue,
  isWaitingOnMarking,
  issueFromQueryError,
  needsYou,
  ontrackStatus,
  sortTasks,
  targetProgress,
  useLastDefined,
} from "./campus";

type View = { readonly kind: "home" } | { readonly kind: "unit"; readonly projectId: number };

const NEEDS_YOU_PREVIEW = 6;
const COMING_UP_DAYS = 14;

/**
 * OnTrack as a dashboard: a card per unit with its grade target and progress,
 * then the tasks that need the student, what is coming up, and what is
 * waiting on marking. A unit card opens that unit's tasks by grade tier.
 */
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
  const [view, setView] = useState<View>({ kind: "home" });
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const tasksByUnit = useMemo(() => {
    const groups = new Map<number, OnTrackTask[]>();
    for (const task of data?.tasks ?? []) {
      groups.set(task.projectId, [...(groups.get(task.projectId) ?? []), task]);
    }
    return new Map([...groups].map(([projectId, tasks]) => [projectId, sortTasks(tasks)]));
  }, [data?.tasks]);
  const openTask = (task: OnTrackTask) => {
    setView({ kind: "unit", projectId: task.projectId });
    setOpenTaskId(task.taskId);
  };
  const unit =
    view.kind === "unit"
      ? data?.units.find((candidate) => candidate.projectId === view.projectId)
      : null;

  return (
    <CampusPage
      app={app}
      environmentId={environmentId}
      meta={data?.meta ?? null}
      issue={issue}
      loading={query.isPending}
      onRefresh={() => (force ? query.refresh() : setForce(true))}
    >
      {data && unit ? (
        <UnitView
          unit={unit}
          tasks={tasksByUnit.get(unit.projectId) ?? []}
          openTaskId={openTaskId}
          onToggle={(taskId) => setOpenTaskId((open) => (open === taskId ? null : taskId))}
          onBack={() => setView({ kind: "home" })}
          environmentId={environmentId}
        />
      ) : data ? (
        <Dashboard
          units={data.units}
          tasksByUnit={tasksByUnit}
          onOpenUnit={(projectId) => {
            setOpenTaskId(null);
            setView({ kind: "unit", projectId });
          }}
          onOpenTask={openTask}
        />
      ) : null}
    </CampusPage>
  );
}

function Dashboard({
  units,
  tasksByUnit,
  onOpenUnit,
  onOpenTask,
}: {
  readonly units: ReadonlyArray<OnTrackUnit>;
  readonly tasksByUnit: ReadonlyMap<number, ReadonlyArray<OnTrackTask>>;
  readonly onOpenUnit: (projectId: number) => void;
  readonly onOpenTask: (task: OnTrackTask) => void;
}) {
  const all = [...tasksByUnit.values()].flat();
  const needing = sortTasks(all.filter((task) => needsYou(task)));
  const coming = sortTasks(
    all.filter((task) => {
      if (task.status === "complete" || needsYou(task)) return false;
      const days = daysUntil(task.dueDate ?? task.targetDate);
      return days !== null && days >= 0 && days <= COMING_UP_DAYS;
    }),
  );
  const marking = sortTasks(all.filter((task) => isWaitingOnMarking(task)));
  const [showAllNeeding, setShowAllNeeding] = useState(false);
  const period = units[0]?.teachingPeriod ?? null;
  const ends = units.map((unit) => unit.endDate).filter((date): date is string => date !== null);
  const endDate = ends.length > 0 ? [...ends].sort().at(-1)! : null;
  const daysLeft = daysUntil(endDate);
  const unitCode = (task: OnTrackTask) =>
    units.find((unit) => unit.projectId === task.projectId)?.unitCode ?? task.unitCode;

  return (
    <div className="space-y-10 pt-2">
      {period ? (
        <p className="text-sm text-muted-foreground">
          {period}
          {endDate && daysLeft !== null
            ? daysLeft >= 0
              ? ` · ends ${formatShortDate(endDate)}, ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`
              : ` · ended ${formatShortDate(endDate)}`
            : ""}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {units.map((unit) => (
          <UnitCard
            key={unit.projectId}
            unit={unit}
            tasks={tasksByUnit.get(unit.projectId) ?? []}
            onOpen={() => onOpenUnit(unit.projectId)}
          />
        ))}
      </div>
      {units.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No current units.</p>
      ) : null}
      {needing.length > 0 ? (
        <TaskGroup
          title="Needs you"
          count={needing.length}
          tasks={showAllNeeding ? needing : needing.slice(0, NEEDS_YOU_PREVIEW)}
          unitCode={unitCode}
          onOpen={onOpenTask}
          footer={
            needing.length > NEEDS_YOU_PREVIEW ? (
              <Button
                size="sm"
                variant="ghost-muted"
                onClick={() => setShowAllNeeding((value) => !value)}
              >
                {showAllNeeding ? "Show fewer" : `Show all ${needing.length}`}
              </Button>
            ) : null
          }
        />
      ) : null}
      {coming.length > 0 ? (
        <TaskGroup
          title="Coming up"
          count={coming.length}
          tasks={coming}
          unitCode={unitCode}
          onOpen={onOpenTask}
        />
      ) : null}
      {marking.length > 0 ? (
        <TaskGroup
          title="Waiting on marking"
          count={marking.length}
          tasks={marking}
          unitCode={unitCode}
          onOpen={onOpenTask}
        />
      ) : null}
      {units.length > 0 && needing.length === 0 && coming.length === 0 && marking.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting on you.</p>
      ) : null}
    </div>
  );
}

function UnitCard({
  unit,
  tasks,
  onOpen,
}: {
  readonly unit: OnTrackUnit;
  readonly tasks: ReadonlyArray<OnTrackTask>;
  readonly onOpen: () => void;
}) {
  const progress = targetProgress(tasks, unit.targetGrade);
  const ratio = progress.needed === 0 ? 0 : progress.done / progress.needed;
  const target = gradeName(unit.targetGrade);
  const toFix = tasks.filter((task) => needsYou(task) && !isOverdue(task)).length;
  const overdue = tasks.filter((task) => isOverdue(task)).length;
  const marking = tasks.filter((task) => isWaitingOnMarking(task)).length;
  const next = sortTasks(tasks).find((task) => task.status !== "complete");
  const ladder = GRADE_TIERS.map((tier) => {
    const inTier = tasks.filter((task) => task.targetGrade === tier.grade);
    return {
      ...tier,
      done: inTier.filter((task) => task.status === "complete").length,
      total: inTier.length,
    };
  }).filter((tier) => tier.total > 0);
  return (
    <div
      role="button"
      tabIndex={0}
      className="flex min-w-0 cursor-default flex-col gap-3 rounded-2xl border border-border px-4 py-4 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-lg text-foreground">{unit.unitCode}</span>
          {target ? <span className="text-xs text-muted-foreground">Target {target}</span> : null}
        </div>
        <div className="truncate text-sm text-muted-foreground">{unit.unitName}</div>
      </div>
      <div className="space-y-1.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full rounded-full bg-(--codex-accent)"
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-foreground">
            {progress.done} of {progress.needed}
            {target
              ? ` for ${GRADE_TIERS.find((tier) => tier.name === target)?.short ?? target}`
              : ""}
          </span>
          <span className="text-muted-foreground">{Math.round(ratio * 100)}%</span>
        </div>
      </div>
      {ladder.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {ladder.map((tier) => (
            <span key={tier.grade} className={tier.done === tier.total ? "text-foreground" : ""}>
              {tier.short} {tier.done}/{tier.total}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {overdue > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", TONE_DOT.danger)} />
            {overdue} overdue
          </span>
        ) : null}
        {toFix > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", TONE_DOT.warning)} />
            {toFix} to fix
          </span>
        ) : null}
        {marking > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", TONE_DOT.info)} />
            {marking} with markers
          </span>
        ) : null}
        {overdue === 0 && toFix === 0 && marking === 0 ? <span>All clear</span> : null}
      </div>
      {next ? (
        <div className="truncate text-xs text-muted-foreground">
          Next: {next.taskAbbreviation} {next.taskName}
          {dueLabel(next) ? ` · ${dueLabel(next)}` : ""}
        </div>
      ) : null}
    </div>
  );
}

function TaskGroup({
  title,
  count,
  tasks,
  unitCode,
  onOpen,
  footer,
}: {
  readonly title: string;
  readonly count: number;
  readonly tasks: ReadonlyArray<OnTrackTask>;
  readonly unitCode: (task: OnTrackTask) => string;
  readonly onOpen: (task: OnTrackTask) => void;
  readonly footer?: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2 pb-2">
        <h2 className="text-base text-foreground">{title}</h2>
        <span className="text-sm text-muted-foreground">{count}</span>
      </div>
      <div role="list" className="flex flex-col gap-0.5">
        {tasks.map((task) => {
          const status = ontrackStatus(task.status);
          const overdue = isOverdue(task);
          return (
            <div key={task.taskId} role="listitem">
              <div
                role="button"
                tabIndex={0}
                className="flex min-w-0 cursor-default items-center gap-3 rounded-lg px-2 py-2 leading-6 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpen(task)}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onOpen(task);
                }}
              >
                <span className="w-16 shrink-0 text-sm text-muted-foreground">
                  {unitCode(task)}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">
                  <span className="text-muted-foreground">{task.taskAbbreviation} </span>
                  {task.taskName}
                </span>
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
                  {dueLabel(task)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {footer ? <div className="pt-1">{footer}</div> : null}
    </section>
  );
}

function UnitView({
  unit,
  tasks,
  openTaskId,
  onToggle,
  onBack,
  environmentId,
}: {
  readonly unit: OnTrackUnit;
  readonly tasks: ReadonlyArray<OnTrackTask>;
  readonly openTaskId: number | null;
  readonly onToggle: (taskId: number) => void;
  readonly onBack: () => void;
  readonly environmentId: EnvironmentId | null;
}) {
  const progress = targetProgress(tasks, unit.targetGrade);
  const target = gradeName(unit.targetGrade);
  const tiers = GRADE_TIERS.map((tier) => ({
    ...tier,
    tasks: tasks.filter((task) => task.targetGrade === tier.grade),
  })).filter((tier) => tier.tasks.length > 0);
  const untiered = tasks.filter((task) => task.targetGrade === null);
  return (
    <div className="pt-1">
      <div className="flex items-center gap-2 pb-4">
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Back to all units"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-lg text-foreground">
            {unit.unitCode}
            <span className="text-muted-foreground"> {unit.unitName}</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {progress.done} of {progress.needed} tasks done
            {target ? ` for ${target}` : ""}
            {unit.teachingPeriod ? ` · ${unit.teachingPeriod}` : ""}
          </p>
        </div>
      </div>
      {tiers.map((tier) => (
        <section key={tier.grade} className="pt-6">
          <div className="flex items-baseline gap-2 pb-2">
            <h3 className="text-base text-foreground">{tier.name}</h3>
            <span className="text-sm text-muted-foreground">
              {tier.tasks.filter((task) => task.status === "complete").length}/{tier.tasks.length}
            </span>
          </div>
          <div role="list" className="flex flex-col gap-0.5">
            {tier.tasks.map((task) => (
              <TaskRow
                key={task.taskId}
                task={task}
                open={openTaskId === task.taskId}
                onToggle={() => onToggle(task.taskId)}
                environmentId={environmentId}
              />
            ))}
          </div>
        </section>
      ))}
      {untiered.length > 0 ? (
        <section className="pt-6">
          <h3 className="pb-2 text-base text-foreground">Tasks</h3>
          <div role="list" className="flex flex-col gap-0.5">
            {untiered.map((task) => (
              <TaskRow
                key={task.taskId}
                task={task}
                open={openTaskId === task.taskId}
                onToggle={() => onToggle(task.taskId)}
                environmentId={environmentId}
              />
            ))}
          </div>
        </section>
      ) : null}
      {tasks.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No tasks.</p>
      ) : null}
    </div>
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
  const target = gradeName(details?.targetGrade ?? task.targetGrade);
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
            {target ? (
              <>
                <dt>Counts toward</dt>
                <dd className="text-foreground">{target}</dd>
              </>
            ) : null}
            {details.weighting !== null ? (
              <>
                <dt>Weight</dt>
                <dd className="text-foreground">{details.weighting}</dd>
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
