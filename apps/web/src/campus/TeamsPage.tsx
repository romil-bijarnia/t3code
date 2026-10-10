import type { EnvironmentId, TeamsThread } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { Button } from "../components/ui/button";
import type { PinnedApp } from "../pinnedApps/pinnedApps";
import { CampusPage } from "./CampusPage";
import { issueFromQueryError, useLastDefined } from "./campus";

const THREAD_PAGE = 25;

/** Teams as a page: recent chats and channels, and one thread's messages. */
export function TeamsPage({ app }: { readonly app: PinnedApp }) {
  const environmentId = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<TeamsThread | null>(null);
  if (selected?.ref) {
    return (
      <ThreadView
        app={app}
        environmentId={environmentId}
        thread={selected}
        onBack={() => setSelected(null)}
      />
    );
  }
  return <ThreadList app={app} environmentId={environmentId} onOpen={setSelected} />;
}

function ThreadList({
  app,
  environmentId,
  onOpen,
}: {
  readonly app: PinnedApp;
  readonly environmentId: EnvironmentId | null;
  readonly onOpen: (thread: TeamsThread) => void;
}) {
  const [force, setForce] = useState(false);
  const query = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.campusTeamsThreads({
          environmentId,
          input: { top: THREAD_PAGE, ...(force ? { refresh: true } : {}) },
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
      {data ? (
        <div role="list" className="flex flex-col gap-0.5 pt-2">
          {data.threads.map((thread, index) => (
            <div key={thread.ref ?? `${index}`} role="listitem">
              <div
                role="button"
                tabIndex={0}
                className="flex min-w-0 cursor-default items-center gap-3 rounded-lg px-2 py-2.5 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onOpen(thread)}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onOpen(thread);
                }}
              >
                <span
                  aria-hidden
                  className={
                    thread.unread
                      ? "size-2 shrink-0 rounded-full bg-(--codex-accent)"
                      : "size-2 shrink-0"
                  }
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-foreground">{thread.title ?? "Untitled"}</span>
                  {thread.preview ? (
                    <span className="truncate text-sm text-muted-foreground">{thread.preview}</span>
                  ) : null}
                </span>
                {thread.timestamp ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{thread.timestamp}</span>
                ) : null}
              </div>
            </div>
          ))}
          {data.threads.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No recent threads.</p>
          ) : null}
        </div>
      ) : null}
    </CampusPage>
  );
}

function ThreadView({
  app,
  environmentId,
  thread,
  onBack,
}: {
  readonly app: PinnedApp;
  readonly environmentId: EnvironmentId | null;
  readonly thread: TeamsThread;
  readonly onBack: () => void;
}) {
  const [force, setForce] = useState(false);
  const query = useEnvironmentQuery(
    environmentId && thread.ref
      ? serverEnvironment.campusTeamsThread({
          environmentId,
          input: { threadRef: thread.ref, ...(force ? { refresh: true } : {}) },
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
        <Button size="icon-sm" variant="ghost-muted" aria-label="Back to threads" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <h2 className="min-w-0 truncate text-lg text-foreground">
          {data?.title ?? thread.title ?? "Thread"}
        </h2>
      </div>
      {data ? (
        <div className="flex flex-col">
          {data.messages.map((message, index) => (
            <div
              key={message.ref ?? `${index}`}
              className={message.isReply ? "ml-6 border-l border-border py-3 pl-4" : "py-3"}
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate text-foreground">{message.sender ?? "Unknown"}</span>
                {message.sentAt ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{message.sentAt}</span>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap text-foreground/90">
                {message.body ?? message.preview ?? ""}
              </p>
              {message.replyCount > 0 ? (
                <div className="pt-1 text-xs text-muted-foreground">
                  {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
                </div>
              ) : null}
            </div>
          ))}
          {data.messages.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No messages read.</p>
          ) : null}
        </div>
      ) : null}
    </CampusPage>
  );
}
