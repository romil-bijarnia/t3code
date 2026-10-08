import type { CampusApp, CampusFetchMeta, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { PinnedApp } from "../pinnedApps/pinnedApps";
import { type CampusIssue, updatedLabel } from "./campus";

const APP_LABEL: Record<CampusApp, string> = {
  ontrack: "OnTrack",
  deakinsync: "DeakinSync",
  teams: "Teams",
  outlook: "Outlook",
};

/** Re-renders once a minute so "Updated 4 min ago" keeps moving. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The frame every campus page shares: the app's name, when its data was
 * read, a refresh, a way out to the website, and the sign-in or lane notice
 * when the lane cannot answer.
 */
export function CampusPage({
  app,
  environmentId,
  meta,
  issue,
  loading,
  onRefresh,
  children,
}: {
  readonly app: PinnedApp;
  readonly environmentId: EnvironmentId | null;
  readonly meta: CampusFetchMeta | null;
  /** The lane's objection, from a failed read or from stale data. */
  readonly issue: CampusIssue | null;
  readonly loading: boolean;
  readonly onRefresh: () => void;
  readonly children: ReactNode;
}) {
  const now = useMinuteTick();
  const campusApp = app.id as CampusApp;
  const hasContent = children !== null && children !== undefined && children !== false;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="App breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem>
              <h1>{app.name}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="flex shrink-0 items-center gap-2">
            {meta ? (
              <span className="text-xs text-muted-foreground">
                {meta.stale ? "Last copy · " : ""}
                {updatedLabel(meta.fetchedAt, now)}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label="Refresh"
                    disabled={loading}
                    onClick={onRefresh}
                  />
                }
              >
                <RotateCwIcon className={loading ? "animate-spin" : undefined} />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Refresh</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`Open ${app.name} in browser`}
                    onClick={() => void readLocalApi()?.shell.openExternal(app.url)}
                  />
                }
              >
                <ExternalLinkIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Open in browser</TooltipPopup>
            </Tooltip>
          </div>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          <div className="mx-auto w-full max-w-3xl px-6 pt-4 pb-16">
            {issue && hasContent ? (
              <CampusNotice
                app={campusApp}
                environmentId={environmentId}
                issue={issue}
                compact
                onRefresh={onRefresh}
              />
            ) : null}
            {issue && !hasContent ? (
              <CampusNotice
                app={campusApp}
                environmentId={environmentId}
                issue={issue}
                onRefresh={onRefresh}
              />
            ) : null}
            {!issue && !hasContent && loading ? (
              <p className="py-16 text-center text-sm text-muted-foreground" role="status">
                Reading {APP_LABEL[campusApp]}…
              </p>
            ) : null}
            {children}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * What stands between the page and its data. A sign-in opens the lane's own
 * window on this Mac; the page refreshes itself once that closes.
 */
function CampusNotice({
  app,
  environmentId,
  issue,
  compact = false,
  onRefresh,
}: {
  readonly app: CampusApp;
  readonly environmentId: EnvironmentId | null;
  readonly issue: CampusIssue;
  readonly compact?: boolean;
  readonly onRefresh: () => void;
}) {
  const signIn = useAtomCommand(serverEnvironment.campusSignIn, { label: "campus sign-in" });
  const [signingIn, setSigningIn] = useState(false);
  const startSignIn = async () => {
    if (!environmentId || signingIn) return;
    setSigningIn(true);
    const result = await signIn({ environmentId, input: { app } });
    setSigningIn(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not sign in to ${APP_LABEL[app]}`,
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    onRefresh();
  };
  const title =
    issue.reason === "sign_in_required"
      ? `Sign in to ${APP_LABEL[app]}`
      : issue.reason === "lane_offline"
        ? "The browser lane is offline"
        : `${APP_LABEL[app]} did not answer`;
  const action =
    issue.reason === "sign_in_required" ? (
      <Button size="sm" disabled={signingIn || !environmentId} onClick={() => void startSignIn()}>
        {signingIn ? "Waiting for the sign-in window…" : "Sign in"}
      </Button>
    ) : (
      <Button size="sm" variant="outline" onClick={onRefresh}>
        Try again
      </Button>
    );
  if (compact) {
    return (
      <div className="mb-4 flex items-center justify-between gap-4 rounded-2xl border border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-base text-foreground">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{issue.detail}</div>
        </div>
        {action}
      </div>
    );
  }
  return (
    <div className="flex min-h-80 flex-col items-center justify-center gap-3 text-center">
      <div className="text-lg text-foreground">{title}</div>
      <p className="max-w-md text-sm text-muted-foreground">{issue.detail}</p>
      {issue.reason === "sign_in_required" ? (
        <p className="max-w-md text-xs text-muted-foreground">
          A sign-in window opens on this Mac; finish it there and this page fills in.
        </p>
      ) : null}
      <div className="pt-2">{action}</div>
    </div>
  );
}
