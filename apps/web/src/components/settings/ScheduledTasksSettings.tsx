import { useAtomValue } from "@effect/atom-react";
import {
  Clock3Icon,
  CopyIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliveryOutcome,
  ScheduledTaskWebhookDeliverySummary,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_WEBHOOK_PROMPT } from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { Link } from "@tanstack/react-router";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  WEBHOOK_SIGNATURE_DEFAULTS,
  matchesScheduledTaskScope,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  type DraftState,
  type WorkspaceMode,
} from "./scheduledTasksSettings.logic";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";
import {
  SettingsPageContainer,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  useRelativeTimeTick,
} from "./settingsLayout";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  maxDeliveryAgeMinutes: "",
};

/** Labelled field: a caption sitting above its control. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

/** One titled, bordered list of rows, the way Codex lays out a task form. */
function FormList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex h-8 items-center px-1 text-base text-muted-foreground">
        <span className="opacity-75">{title}</span>
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </div>
  );
}

/**
 * A label on the left and its control on the right. `stacked` puts the
 * control under the label for inputs that need the full width.
 */
function FormRow({
  label,
  htmlFor,
  description,
  stacked = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  description?: string;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        stacked
          ? "space-y-2 px-4 py-3"
          : "flex min-h-11 items-center justify-between gap-4 px-4 py-2"
      }
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-base text-foreground">
          {label}
        </label>
        {description ? (
          <p className="text-xs leading-4 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className={stacked ? undefined : "flex min-w-0 shrink-0 items-center gap-2"}>
        {children}
      </div>
    </div>
  );
}

type RepeatMode = "daily" | "weekdays" | "custom" | "interval" | "webhook";

const REPEAT_LABELS: Record<RepeatMode, string> = {
  daily: "Daily",
  weekdays: "Weekdays",
  custom: "Custom days",
  interval: "Interval",
  webhook: "Webhook",
};
const REPEAT_MODES = Object.keys(REPEAT_LABELS) as RepeatMode[];

function isRepeatMode(value: unknown): value is RepeatMode {
  return typeof value === "string" && value in REPEAT_LABELS;
}

const EVERY_DAY: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6]);
const MONDAY_TO_FRIDAY: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);

function sameDays(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((day) => right.has(day));
}

/** The "Repeat schedule" choice is derived from the draft; `customDays` keeps "Custom days" selected while its set still looks like a preset. */
function repeatOf(draft: DraftState, customDays: boolean): RepeatMode {
  if (draft.scheduleMode !== "fixed") return draft.scheduleMode;
  if (customDays) return "custom";
  if (draft.weekdays.size === 0 || sameDays(draft.weekdays, EVERY_DAY)) return "daily";
  if (sameDays(draft.weekdays, MONDAY_TO_FRIDAY)) return "weekdays";
  return "custom";
}

type StatusFilter = "all" | "active" | "paused";

/** Starter tasks shown while a machine has none, as Codex suggests on its empty page. */
const SUGGESTIONS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly seed: Partial<DraftState>;
}> = [
  {
    id: "daily-brief",
    title: "Daily brief",
    description:
      "Start each weekday with a summary of open pull requests, failing checks, and priorities",
    seed: {
      prompt:
        "Give me a morning brief: open pull requests, failing checks, and what I should prioritize today.",
      scheduleMode: "fixed",
      timeOfDay: "09:00",
      weekdays: MONDAY_TO_FRIDAY,
    },
  },
  {
    id: "weekly-review",
    title: "Weekly review",
    description: "Turn your recent work into a concise status update every Friday",
    seed: {
      prompt: "Review what I worked on this week and draft a short status update.",
      scheduleMode: "fixed",
      timeOfDay: "16:00",
      weekdays: new Set([5]),
    },
  },
  {
    id: "follow-up-monitor",
    title: "Follow-up monitor",
    description:
      "Review recent commits, issues, and review comments and flag anything that needs your attention",
    seed: {
      prompt:
        "Review recent commits, issues, and pull request comments, highlight meaningful changes, and flag anything that needs my attention.",
      scheduleMode: "fixed",
      timeOfDay: "09:00",
      weekdays: EVERY_DAY,
    },
  },
];

function taskStatusLabel(task: ScheduledTask): string {
  if (task.lastRunStatus === "running") return "In progress";
  if (!task.enabled) return "Paused";
  if (task.schedule.type === "webhook") return "Listening";
  return task.nextRunAt ? `Next run, ${relativeLabel(task.nextRunAt)}` : "Not scheduled";
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * Human label for a run timestamp. `formatRelativeTime` only handles the
 * past, and `nextRunAt` is a future instant — render "in 5m" style labels
 * for upcoming runs instead of a misleading "just now".
 */
export function relativeLabel(value: string | null): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

const DELIVERY_OUTCOME_LABELS: Record<ScheduledTaskWebhookDeliveryOutcome, string> = {
  accepted: "Ran",
  dispatch_failed: "Run failed",
  rejected_signature: "Bad signature",
  disabled: "Task paused",
  rate_limited: "Rate limited",
  expired: "Too old",
};

function deliveryOutcomeVariant(outcome: ScheduledTaskWebhookDeliveryOutcome) {
  if (outcome === "accepted") return "success";
  if (outcome === "disabled" || outcome === "rate_limited" || outcome === "expired") {
    return "warning";
  }
  return "error";
}

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId | undefined;
}) {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
    seed?: Partial<DraftState>;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const openForEdit = useCallback((environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  }, []);
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(defaultEnvironment?.environmentId ?? null),
  );
  return (
    <SettingsPageContainer>
      <section className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-medium text-foreground">Scheduled tasks</h2>
            <p className="text-sm text-muted-foreground">
              Ask an agent to schedule tasks, set reminders, or monitor for updates.
            </p>
          </div>
          <Button
            size="sm"
            disabled={!defaultEnvironment || !canCreate}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ environmentId: defaultEnvironment.environmentId, task: null })
            }
          >
            Create
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon aria-hidden className="size-3.5" />
              </InputGroupAddon>
              <InputGroupInput
                id="scheduled-page-search"
                type="search"
                placeholder="Search scheduled tasks"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </InputGroup>
          </div>
          <ToggleGroup
            aria-label="Scheduled task status"
            value={[status]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "all" || next === "active" || next === "paused") setStatus(next);
            }}
          >
            <Toggle value="all">All</Toggle>
            <Toggle value="active">Active</Toggle>
            <Toggle value="paused">Paused</Toggle>
          </ToggleGroup>
        </div>
        {scope.kind === "unavailable" ? (
          <p className="text-sm text-muted-foreground">{scope.message}</p>
        ) : environments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect an environment to manage scheduled tasks.
          </p>
        ) : (
          <div className="@container flex flex-col gap-6">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={`${entry.environmentId}:${target.taskId ?? ""}`}
                environment={entry}
                showEnvironmentHeading={environments.length > 1}
                query={query}
                status={status}
                taskId={
                  (target.environmentId ?? defaultEnvironment?.environmentId) ===
                  entry.environmentId
                    ? target.taskId
                    : undefined
                }
                onEdit={openForEdit}
                onCreate={(seed) =>
                  setEditor({ environmentId: entry.environmentId, task: null, seed })
                }
              />
            ))}
          </div>
        )}
      </section>
      {editor ? (
        <ScheduledTaskEditorDialog
          key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          task={editor.task}
          seed={editor.seed}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ScheduledTaskEnvironmentSection({
  environment,
  showEnvironmentHeading,
  query,
  status,
  taskId,
  onEdit,
  onCreate,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHeading: boolean;
  readonly query: string;
  readonly status: StatusFilter;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly onCreate: (seed: Partial<DraftState>) => void;
}) {
  const { scope } = useSettingsScope();
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const scoped = tasksQuery.data?.tasks.filter((task) =>
    matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
  );
  const linkedTask = scoped?.find((task) => task.id === taskId);
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linkedTask) {
      openedLink.current = true;
      onEdit(environment.environmentId, linkedTask);
    }
  }, [environment.environmentId, linkedTask, onEdit]);
  useRelativeTimeTick(60_000);
  const needle = query.trim().toLowerCase();
  const filtering = needle !== "" || status !== "all";
  const tasks = scoped?.filter(
    (task) =>
      (status === "all" || (status === "active") === task.enabled) &&
      (needle === "" ||
        task.title.toLowerCase().includes(needle) ||
        task.prompt.toLowerCase().includes(needle)),
  );
  return (
    <section className="flex flex-col gap-3">
      {showEnvironmentHeading ? (
        <div className="flex min-w-0 items-center gap-2 border-b border-border pb-3 text-base text-muted-foreground">
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            className="size-3.5"
          />
          <span className="truncate">{environment.label}</span>
        </div>
      ) : null}
      {!connected ? (
        <p className="px-2 text-sm text-muted-foreground" role="status">
          Reconnect {environment.label} to view its scheduled tasks.
        </p>
      ) : tasksQuery.error ? (
        <div className="flex flex-col items-start gap-2 px-2 text-sm text-muted-foreground">
          <span>Scheduled tasks could not be loaded</span>
          <Button size="xs" variant="ghost-muted" onClick={tasksQuery.refresh}>
            Try again
          </Button>
        </div>
      ) : !scoped || !tasks ? (
        <p className="px-2 text-sm text-muted-foreground" role="status">
          Loading scheduled tasks…
        </p>
      ) : (
        <>
          {taskId && !linkedTask ? (
            <p className="px-2 text-sm text-muted-foreground" role="status">
              Scheduled task unavailable. It may have been deleted or is outside the selected
              project scope.
            </p>
          ) : null}
          {scoped.length === 0 && !filtering ? (
            <ScheduledTaskSuggestions onPick={onCreate} />
          ) : tasks.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center text-muted-foreground">
              No scheduled tasks found
            </div>
          ) : (
            <div role="list" className="flex flex-col gap-1">
              {tasks.map((task) => (
                <ScheduledTaskRow
                  key={task.id}
                  environmentId={environment.environmentId}
                  task={task}
                  onEdit={() => onEdit(environment.environmentId, task)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ScheduledTaskSuggestions({
  onPick,
}: {
  readonly onPick: (seed: Partial<DraftState>) => void;
}) {
  return (
    <section>
      <h3 className="px-2 pb-2 text-lg leading-6 text-muted-foreground">Suggestions</h3>
      <div className="flex flex-col gap-1">
        {SUGGESTIONS.map((suggestion) => (
          <div
            key={suggestion.id}
            className="flex items-center gap-3 rounded-lg px-2 py-2 leading-6"
          >
            <span className="flex size-7 shrink-0 items-center justify-center">
              <Clock3Icon className="size-4 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-foreground">{suggestion.title}</div>
              <div className="line-clamp-1 text-sm text-muted-foreground">
                {suggestion.description}
              </div>
            </div>
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label={`Add ${suggestion.title} scheduled task`}
              onClick={() => onPick({ title: suggestion.title, ...suggestion.seed })}
            >
              <PlusIcon />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ScheduledTaskRow({
  environmentId,
  task,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onEdit: () => void;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : action === "run"
          ? await run({ environmentId, input: { id: task.id } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update scheduled task",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  const confirmDelete = async () => {
    const confirmed =
      (await requestConfirmDialog(
        `Delete ${task.title}?\nThis will permanently delete the scheduled task and stop future runs.`,
        { variant: "destructive" },
      )) ?? window.confirm(`Delete ${task.title}? This stops future runs.`);
    if (confirmed) await act("delete");
  };
  return (
    <div role="listitem" className="group relative">
      <div
        role="button"
        tabIndex={0}
        className="flex min-w-0 cursor-default items-center gap-3 rounded-lg px-2 py-2 leading-6 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onEdit}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onEdit();
        }}
      >
        <span className="flex size-7 shrink-0 items-center justify-center">
          <Clock3Icon className="size-4 text-muted-foreground" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-x-4 @sm:flex-row @sm:items-center">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-foreground">{task.title}</span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {scheduleLabel(task.schedule)}
            </span>
          </span>
          <span className="truncate text-sm text-muted-foreground @sm:max-w-1/2 @sm:shrink-0 @sm:text-end">
            {taskStatusLabel(task)}
          </span>
        </div>
        <span className="flex min-h-7 w-14 shrink-0 items-center justify-end pr-1">
          {task.lastRunStatus === "failed" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="Last run failed"
                    className="size-2 rounded-full bg-destructive group-hover:opacity-0 group-focus-within:opacity-0"
                  />
                }
              />
              <TooltipPopup side="top">{task.lastRunError ?? "Last run failed"}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      </div>
      <div
        role="presentation"
        className={cn(
          "absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-0.5",
          menuOpen
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Button
          size="icon-xs"
          variant="ghost-muted"
          disabled={busy || !canOperate}
          aria-label={task.enabled ? "Pause scheduled task" : "Resume scheduled task"}
          onClick={() => void act("toggle")}
        >
          {task.enabled ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Menu onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={busy || !canOperate}
                aria-label="Scheduled task actions"
              />
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onEdit}>
              <PencilIcon />
              Edit
            </MenuItem>
            {isWebhook ? (
              <MenuItem onClick={() => setDeliveriesOpen(true)}>
                <InboxIcon />
                Deliveries
              </MenuItem>
            ) : (
              <MenuItem onClick={() => void act("run")}>
                <PlayIcon />
                Run now
              </MenuItem>
            )}
            <MenuItem onClick={() => void act("toggle")}>
              {task.enabled ? <PauseIcon /> : <PlayIcon />}
              {task.enabled ? "Pause" : "Resume"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => void confirmDelete()}>
              <Trash2Icon />
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
        {deliveriesOpen ? (
          <WebhookDeliveriesDialog
            environmentId={environmentId}
            task={task}
            onClose={() => setDeliveriesOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function WebhookDeliveriesDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const deliveriesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskWebhookDeliveries({ environmentId, input: { id: task.id } }),
  );
  const [selectedId, setSelectedId] = useState<ScheduledTaskWebhookDeliverySummary["id"] | null>(
    null,
  );
  const selectedQuery = useEnvironmentQuery(
    selectedId === null
      ? null
      : serverEnvironment.scheduledTaskWebhookDelivery({
          environmentId,
          input: { id: task.id, deliveryId: selectedId },
        }),
  );
  const deliveries = deliveriesQuery.data?.deliveries ?? null;
  const selected = selectedQuery.data?.delivery ?? null;
  const error = selectedId === null ? deliveriesQuery.error : selectedQuery.error;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deliveries · {task.title}</DialogTitle>
          <DialogDescription>Recent requests to this task's webhook URL.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && selectedQuery.error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading delivery…
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={deliveryOutcomeVariant(selected.outcome)}>
                  {DELIVERY_OUTCOME_LABELS[selected.outcome]}
                </Badge>
                <span>
                  {selected.method} · {relativeLabel(selected.receivedAt)}
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">Signature verified</span>
                ) : null}
              </div>
              {selected.error ? <p className="text-sm text-destructive">{selected.error}</p> : null}
              <DeliveryBlock title="Prompt sent to the agent">
                {selected.renderedPrompt ?? "No run was started for this request."}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Empty placeholders: {selected.missingFields.join(", ")}
                </p>
              ) : null}
              <DeliveryBlock title="Headers">
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title="Query">{selected.query}</DeliveryBlock>
              ) : null}
              <DeliveryBlock title={selected.bodyTruncated ? "Body (truncated)" : "Body"}>
                {selected.body || "(empty)"}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading deliveries…
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm hover:bg-accent/40"
                    onClick={() => setSelectedId(delivery.id)}
                  >
                    <Badge variant={deliveryOutcomeVariant(delivery.outcome)}>
                      {DELIVERY_OUTCOME_LABELS[delivery.outcome]}
                    </Badge>
                    <span>{delivery.method}</span>
                    <span className="text-muted-foreground">
                      {relativeLabel(delivery.receivedAt)}
                    </span>
                    {delivery.missingFields.length > 0 ? (
                      <span className="text-muted-foreground">
                        {delivery.missingFields.length} empty placeholder
                        {delivery.missingFields.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
              Back
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deliveriesQuery.isPending}
              onClick={deliveriesQuery.refresh}
            >
              Refresh
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeliveryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{title}</Label>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
        {children}
      </pre>
    </div>
  );
}

function WebhookEndpointField({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}) {
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "webhook URL" });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">The URL appears after you save.</p>;
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog("Rotate this webhook URL?\nThe current URL stops working.", {
        variant: "destructive",
      })) ??
      // No themed dialog host is mounted; fall back to the native prompt
      // rather than rotating unasked.
      window.confirm("Rotate this webhook URL? The current URL stops working.");
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rotate webhook URL",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label="Webhook URL"
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          // A bare path is not a URL a sender can call.
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          Rotate
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

/**
 * Whether T3 Connect forwards requests live or holds them while the
 * environment is offline. The setting is per environment and only readable
 * for this machine's own environment, so other environments show nothing.
 */
function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? "Held for up to 24 hours while this environment is offline. "
        : "Forwarded live. Requests fail while this environment is offline. "}
      <Link to="/settings/connections" className="underline underline-offset-2">
        Change in Connections
      </Link>
    </p>
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  seed,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly seed?: Partial<DraftState> | undefined;
  readonly onClose: () => void;
}) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId &&
          matchesScheduledTaskScope(scope, environmentId, project.id),
      ),
    [allProjects, environmentId, scope],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [draft, setDraft] = useState<DraftState>(() =>
    task ? taskToDraft(task) : { ...EMPTY_DRAFT, projectId: projects[0]?.id ?? "", ...seed },
  );
  const [customDays, setCustomDays] = useState(false);
  const repeat = repeatOf(draft, customDays);
  const setRepeat = (mode: RepeatMode) => {
    setCustomDays(mode === "custom");
    setDraft((current) => {
      if (mode === "interval" || mode === "webhook") {
        return {
          ...current,
          scheduleMode: mode,
          prompt:
            mode === "webhook" && !current.prompt.trim() ? DEFAULT_WEBHOOK_PROMPT : current.prompt,
        };
      }
      return {
        ...current,
        scheduleMode: "fixed",
        weekdays:
          mode === "daily" ? EVERY_DAY : mode === "weekdays" ? MONDAY_TO_FRIDAY : current.weekdays,
      };
    });
  };
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  const editingTaskMissing =
    draft.editingId !== null &&
    tasksQuery.data !== null &&
    !tasksQuery.data.tasks.some((entry) => entry.id === draft.editingId);
  // The live row, so a rotated URL shows up without reopening the dialog.
  // Once the list has loaded, a missing task is gone; don't keep showing its URL.
  const liveTask = tasksQuery.data
    ? (tasksQuery.data.tasks.find((entry) => entry.id === draft.editingId) ?? null)
    : task;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  // The real model picker is keyed by a `${instanceId}:${model}` string, which
  // is exactly how the draft stores its selection.
  const firstInstance = instanceEntries[0];
  const activeSelection = draft.modelKey
    ? splitModelKey(draft.modelKey)
    : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      editingTaskMissing ||
      !connected ||
      tasksQuery.data === null
    )
      return;
    const selection = activeSelection;
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !projects.some((project) => project.id === selectedProjectId) ||
      selection === null
    ) {
      reportFailure("Scheduled task is incomplete", "Add a name, prompt, project, and model.");
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      reportFailure(
        "Invalid age limit",
        `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.`,
      );
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure("Signing secret is required", "Enter the signature header and secret.");
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure("Invalid interval", "Enter an interval of at least one minute.");
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure("Checkout path is required", "Enter the path of the checkout to run in.");
      return;
    }
    // Keep the original selection object (with provider options) when the
    // picker still points at the same instance+model.
    const modelSelection =
      draft.baseModelSelection !== null &&
      draft.baseModelSelection.instanceId === selection.instanceId &&
      draft.baseModelSelection.model === selection.model
        ? draft.baseModelSelection
        : selection;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
      projectId: selectedProjectId as ProjectId,
      threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
      workspaceStrategy,
      modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertTask({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save scheduled task", squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {draft.editingId ? "Edit scheduled task" : "New scheduled task"}
          </DialogTitle>
        </DialogHeader>

        <DialogPanel>
          <fieldset disabled={saving} className="space-y-6">
            {!connected ? (
              <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
            ) : null}
            {tasksQuery.error ? (
              <p className="text-sm text-destructive" role="status">
                {tasksQuery.error}
              </p>
            ) : null}
            {editingTaskMissing ? (
              <p className="text-sm text-destructive" role="status">
                This scheduled task no longer exists.
              </p>
            ) : null}

            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="scheduled-task-title">Name</Label>
                <input
                  id="scheduled-task-title"
                  className="m-0 w-full min-w-0 appearance-none bg-transparent p-0 text-lg leading-tight text-foreground outline-none placeholder:text-placeholder"
                  placeholder="Scheduled task title"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="scheduled-task-prompt">Prompt</Label>
                <textarea
                  id="scheduled-task-prompt"
                  rows={3}
                  className="field-sizing-content m-0 max-h-64 w-full min-w-0 resize-none bg-transparent p-0 text-base text-foreground outline-none placeholder:text-placeholder"
                  placeholder="Describe what the agent should do"
                  value={draft.prompt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                />
              </div>
            </div>

            {task?.schedule.type === "interval" &&
            task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
              <p className="text-sm text-muted-foreground" role="status">
                This task uses a legacy interval below one minute. Saving updates it to at least one
                minute.
              </p>
            ) : null}

            <FormList title="Frequency">
              <FormRow label="Repeat schedule" htmlFor="scheduled-task-repeat">
                <Select
                  value={repeat}
                  onValueChange={(value) => {
                    if (isRepeatMode(value)) setRepeat(value);
                  }}
                >
                  <SelectTrigger id="scheduled-task-repeat" size="sm" variant="ghost">
                    <SelectValue>{REPEAT_LABELS[repeat]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {REPEAT_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {REPEAT_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </FormRow>
              {draft.scheduleMode === "fixed" ? (
                <FormRow label="Time" htmlFor="scheduled-task-time">
                  <Input
                    type="time"
                    id="scheduled-task-time"
                    nativeInput
                    size="sm"
                    className="w-28"
                    value={draft.timeOfDay}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                    }
                  />
                </FormRow>
              ) : null}
              {repeat === "custom" ? (
                <FormRow label="On">
                  <ToggleGroup
                    multiple
                    variant="outline"
                    size="sm"
                    aria-label="Days of the week"
                    value={[...draft.weekdays].map(String)}
                    onValueChange={(values) => {
                      if (values.length === 0) return;
                      setDraft((current) => ({
                        ...current,
                        weekdays: new Set(values.map(Number)),
                      }));
                    }}
                  >
                    {WEEKDAY_ORDER.map((day) => (
                      <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                        {WEEKDAY_SHORT[day]}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </FormRow>
              ) : null}
              {draft.scheduleMode === "interval" ? (
                <FormRow label="Every" htmlFor="scheduled-task-interval">
                  <Input
                    type="number"
                    id="scheduled-task-interval"
                    nativeInput
                    size="sm"
                    min={1}
                    step="any"
                    className="w-20"
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">minutes</span>
                </FormRow>
              ) : null}
              {draft.scheduleMode === "webhook" ? (
                <>
                  <FormRow
                    stacked
                    label="Webhook URL"
                    description={
                      "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
                    }
                  >
                    <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                  </FormRow>
                  <FormRow
                    label="Skip requests older than"
                    description="Minutes, optional"
                    htmlFor="scheduled-task-max-age"
                  >
                    <Input
                      id="scheduled-task-max-age"
                      type="number"
                      nativeInput
                      size="sm"
                      min={1}
                      max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                      className="w-28"
                      placeholder="Any age"
                      value={draft.maxDeliveryAgeMinutes}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          maxDeliveryAgeMinutes: event.target.value,
                        }))
                      }
                    />
                  </FormRow>
                  <FormRow
                    label="Require signature"
                    description="Reject requests without a valid HMAC-SHA256 signature of the body."
                    htmlFor="scheduled-task-signature"
                  >
                    <Switch
                      id="scheduled-task-signature"
                      checked={draft.signatureEnabled}
                      onCheckedChange={(signatureEnabled) =>
                        setDraft((current) => ({ ...current, signatureEnabled }))
                      }
                    />
                  </FormRow>
                  {draft.signatureEnabled ? (
                    <FormRow stacked label="Signature">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Header" htmlFor="scheduled-task-signature-header">
                          <Input
                            id="scheduled-task-signature-header"
                            size="sm"
                            value={draft.signatureHeader}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                signatureHeader: event.target.value,
                              }))
                            }
                          />
                        </Field>
                        <Field label="Prefix" htmlFor="scheduled-task-signature-prefix">
                          <Input
                            id="scheduled-task-signature-prefix"
                            size="sm"
                            value={draft.signaturePrefix}
                            placeholder="None"
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                signaturePrefix: event.target.value,
                              }))
                            }
                          />
                        </Field>
                        <Field label="Encoding" htmlFor="scheduled-task-signature-encoding">
                          <Select
                            value={draft.signatureEncoding}
                            onValueChange={(value) =>
                              setDraft((current) => ({
                                ...current,
                                signatureEncoding: value === "base64" ? "base64" : "hex",
                              }))
                            }
                          >
                            <SelectTrigger size="sm" id="scheduled-task-signature-encoding">
                              <SelectValue>{draft.signatureEncoding}</SelectValue>
                            </SelectTrigger>
                            <SelectPopup>
                              <SelectItem value="hex">hex</SelectItem>
                              <SelectItem value="base64">base64</SelectItem>
                            </SelectPopup>
                          </Select>
                        </Field>
                        <Field label="Secret" htmlFor="scheduled-task-signature-secret">
                          <Input
                            id="scheduled-task-signature-secret"
                            size="sm"
                            type="password"
                            autoComplete="off"
                            value={draft.signatureSecret}
                            placeholder={
                              liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                                ? "Unchanged"
                                : "Shared secret"
                            }
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                signatureSecret: event.target.value,
                              }))
                            }
                          />
                        </Field>
                      </div>
                    </FormRow>
                  ) : null}
                </>
              ) : null}
            </FormList>

            <FormList title="Details">
              <FormRow label="Runs on" htmlFor="scheduled-task-environment">
                <Select
                  value={environmentId}
                  disabled={task !== null || saving}
                  onValueChange={(id) => {
                    const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                    if (!next) return;
                    setEnvironmentId(next.environmentId);
                    setDraft((current) => ({
                      ...current,
                      projectId: "",
                      modelKey: "",
                      baseModelSelection: null,
                      baseRef: "main",
                      startFromOrigin: true,
                      existingWorktreePath: "",
                    }));
                  }}
                >
                  <SelectTrigger id="scheduled-task-environment" size="sm" variant="ghost">
                    <SelectValue>
                      <span className="flex items-center gap-2">
                        <EnvironmentMachineIcon
                          kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                          className="size-4"
                        />
                        {environment?.label ?? "Unavailable environment"}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {connectedEnvironments.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        <EnvironmentMachineIcon
                          kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                          className="size-4"
                        />
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </FormRow>
              <FormRow label="Project" htmlFor="scheduled-task-project">
                <Select
                  value={selectedProjectId}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                  }
                >
                  <SelectTrigger size="sm" variant="ghost" id="scheduled-task-project">
                    <SelectValue placeholder="Select project">{selectedProject?.title}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </FormRow>
              <FormRow label="Workspace" htmlFor="scheduled-task-workspace">
                <Select
                  value={draft.workspaceMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                  }
                >
                  <SelectTrigger size="sm" variant="ghost" id="scheduled-task-workspace">
                    <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="worktree">Create a new worktree</SelectItem>
                    <SelectItem value="root">Use the project checkout</SelectItem>
                    <SelectItem value="existing_worktree">Use a specific checkout</SelectItem>
                  </SelectPopup>
                </Select>
              </FormRow>
              {draft.workspaceMode === "worktree" ? (
                <FormRow stacked label="Base branch" htmlFor="scheduled-task-base-ref">
                  <WorktreeBaseBranchPicker
                    key={`${environmentId}:${selectedProjectId}`}
                    id="scheduled-task-base-ref"
                    environmentId={environmentId}
                    cwd={selectedProject?.workspaceRoot ?? null}
                    value={draft.baseRef}
                    onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
                    startFromOrigin={draft.startFromOrigin}
                    onStartFromOriginChange={(startFromOrigin) =>
                      setDraft((current) => ({ ...current, startFromOrigin }))
                    }
                    disabled={saving || !connected}
                  />
                </FormRow>
              ) : null}
              {draft.workspaceMode === "existing_worktree" ? (
                <FormRow stacked label="Checkout path" htmlFor="scheduled-task-checkout">
                  <Input
                    id="scheduled-task-checkout"
                    size="sm"
                    value={draft.existingWorktreePath}
                    placeholder="/path/to/checkout"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        existingWorktreePath: event.target.value,
                      }))
                    }
                  />
                </FormRow>
              ) : null}
              <FormRow label="Model">
                <ProviderModelPicker
                  disabled={saving || !connected}
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) =>
                    setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                  }
                />
              </FormRow>
              <FormRow
                label="Active"
                description="Paused tasks stay saved but do not run."
                htmlFor="scheduled-task-enabled"
              >
                <Switch
                  id="scheduled-task-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
                />
              </FormRow>
            </FormList>
          </fieldset>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!canOperate || saving || editingTaskMissing || !connected || !tasksQuery.data}
            onClick={() => void submit()}
          >
            {draft.editingId ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
