import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { Button } from "../components/ui/button";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import type { PinnedApp } from "../pinnedApps/pinnedApps";
import { CampusPage } from "./CampusPage";
import { issueFromQueryError, useLastDefined, withStableKeys } from "./campus";

type OutlookView = "inbox" | "calendar";
const LIST_TOP = 25;

/** Outlook as a page: the unread inbox, one message's conversation, and the calendar. */
export function OutlookPage({ app }: { readonly app: PinnedApp }) {
  const environmentId = usePrimaryEnvironmentId();
  const [view, setView] = useState<OutlookView>("inbox");
  const [openSubject, setOpenSubject] = useState<string | null>(null);
  const switcher = (
    <ToggleGroup
      aria-label="Outlook view"
      value={[view]}
      onValueChange={(values) => {
        const next = values[0];
        if (next === "inbox" || next === "calendar") {
          setView(next);
          setOpenSubject(null);
        }
      }}
    >
      <Toggle value="inbox">Inbox</Toggle>
      <Toggle value="calendar">Calendar</Toggle>
    </ToggleGroup>
  );
  if (view === "inbox" && openSubject !== null) {
    return (
      <EmailView
        app={app}
        environmentId={environmentId}
        subject={openSubject}
        onBack={() => setOpenSubject(null)}
      />
    );
  }
  return view === "inbox" ? (
    <InboxView
      app={app}
      environmentId={environmentId}
      switcher={switcher}
      onOpen={setOpenSubject}
    />
  ) : (
    <CalendarView app={app} environmentId={environmentId} switcher={switcher} />
  );
}

function InboxView({
  app,
  environmentId,
  switcher,
  onOpen,
}: {
  readonly app: PinnedApp;
  readonly environmentId: EnvironmentId | null;
  readonly switcher: React.ReactNode;
  readonly onOpen: (subject: string) => void;
}) {
  const [force, setForce] = useState(false);
  const query = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.campusOutlookInbox({
          environmentId,
          input: { top: LIST_TOP, ...(force ? { refresh: true } : {}) },
        })
      : null,
  );
  const data = useLastDefined(query.data);
  const issue =
    issueFromQueryError(query.error) ??
    (data?.meta.issue ? { reason: data.meta.issue, detail: data.meta.note ?? "" } : null);
  return (
    <CampusPage
      app={app}
      environmentId={environmentId}
      meta={data?.meta ?? null}
      issue={issue}
      loading={query.isPending}
      onRefresh={() => (force ? query.refresh() : setForce(true))}
    >
      <div className="pt-1 pb-3">{switcher}</div>
      {data ? (
        <div role="list" className="flex flex-col gap-0.5">
          {data.messages.map((message, index) => {
            const subject = message.subject ?? "(no subject)";
            return (
              <div key={message.ref ?? `${index}`} role="listitem">
                <div
                  role="button"
                  tabIndex={0}
                  className="flex min-w-0 cursor-default items-center gap-3 rounded-lg px-2 py-2.5 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpen(subject)}
                  onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onOpen(subject);
                  }}
                >
                  <span
                    aria-hidden
                    className={
                      message.unread
                        ? "size-2 shrink-0 rounded-full bg-(--codex-accent)"
                        : "size-2 shrink-0"
                    }
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 text-foreground">
                        {message.sender ?? "Unknown"}
                      </span>
                      <span className="min-w-0 truncate text-foreground/90">{subject}</span>
                    </span>
                    {message.preview ? (
                      <span className="truncate text-sm text-muted-foreground">
                        {message.preview}
                      </span>
                    ) : null}
                  </span>
                  {message.receivedAt ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {message.receivedAt}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
          {data.messages.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Nothing unread.</p>
          ) : null}
        </div>
      ) : null}
    </CampusPage>
  );
}

function EmailView({
  app,
  environmentId,
  subject,
  onBack,
}: {
  readonly app: PinnedApp;
  readonly environmentId: EnvironmentId | null;
  readonly subject: string;
  readonly onBack: () => void;
}) {
  const [force, setForce] = useState(false);
  const query = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.campusOutlookEmail({
          environmentId,
          input: { subject, ...(force ? { refresh: true } : {}) },
        })
      : null,
  );
  const data = useLastDefined(query.data);
  const issue =
    issueFromQueryError(query.error) ??
    (data?.meta.issue ? { reason: data.meta.issue, detail: data.meta.note ?? "" } : null);
  return (
    <CampusPage
      app={app}
      environmentId={environmentId}
      meta={data?.meta ?? null}
      issue={issue}
      loading={query.isPending}
      onRefresh={() => (force ? query.refresh() : setForce(true))}
    >
      <div className="flex items-center gap-2 pt-1 pb-3">
        <Button size="icon-sm" variant="ghost-muted" aria-label="Back to inbox" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <h2 className="min-w-0 truncate text-lg text-foreground">{subject}</h2>
      </div>
      {data ? (
        <div className="flex flex-col divide-y divide-border">
          {data.messages.map((message, index) => (
            <div key={message.ref ?? `${index}`} className="py-4">
              <div className="flex items-baseline gap-2">
                <span className="text-foreground">{message.sender ?? "Unknown"}</span>
                {message.receivedAt ? (
                  <span className="text-xs text-muted-foreground">{message.receivedAt}</span>
                ) : null}
                {message.hasAttachments ? (
                  <span className="text-xs text-muted-foreground">Attachments</span>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap pt-2 text-foreground/90">
                {message.body ?? message.preview ?? ""}
              </p>
            </div>
          ))}
          {data.messages.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              The message could not be opened.
            </p>
          ) : null}
        </div>
      ) : null}
    </CampusPage>
  );
}

function CalendarView({
  app,
  environmentId,
  switcher,
}: {
  readonly app: PinnedApp;
  readonly environmentId: EnvironmentId | null;
  readonly switcher: React.ReactNode;
}) {
  const [force, setForce] = useState(false);
  const query = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.campusOutlookCalendar({
          environmentId,
          input: { top: LIST_TOP, ...(force ? { refresh: true } : {}) },
        })
      : null,
  );
  const data = useLastDefined(query.data);
  const issue =
    issueFromQueryError(query.error) ??
    (data?.meta.issue ? { reason: data.meta.issue, detail: data.meta.note ?? "" } : null);
  return (
    <CampusPage
      app={app}
      environmentId={environmentId}
      meta={data?.meta ?? null}
      issue={issue}
      loading={query.isPending}
      onRefresh={() => (force ? query.refresh() : setForce(true))}
    >
      <div className="pt-1 pb-3">{switcher}</div>
      {data ? (
        <div role="list" className="flex flex-col gap-0.5">
          {withStableKeys(data.events, (event) => `${event.title}:${event.detail}`).map(
            ([key, event]) => (
              <div
                key={key}
                role="listitem"
                className="flex min-w-0 flex-col rounded-lg px-2 py-2.5"
              >
                <span className="truncate text-foreground">{event.title ?? "Untitled event"}</span>
                {event.detail ? (
                  <span className="text-sm text-muted-foreground">{event.detail}</span>
                ) : null}
              </div>
            ),
          )}
          {data.events.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Nothing coming up.</p>
          ) : null}
        </div>
      ) : null}
    </CampusPage>
  );
}
