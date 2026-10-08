import type { PortalLink } from "@t3tools/contracts";
import { ArrowLeftIcon, ExternalLinkIcon, FileDownIcon, LinkIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import { readLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { Button } from "../components/ui/button";
import type { PinnedApp } from "../pinnedApps/pinnedApps";
import { CampusPage } from "./CampusPage";
import { issueFromQueryError, useLastDefined, withStableKeys } from "./campus";

const HOME_PATH = "/home";
/** Pages the lane can open as DeakinSync; anything else goes to the browser. */
const PORTAL_HOSTS = new Set(["sync.deakin.edu.au", "d2l.deakin.edu.au"]);

function portalPath(href: string): string | null {
  try {
    const url = new URL(href);
    return PORTAL_HOSTS.has(url.hostname) ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

/** DeakinSync as a page: the outline and links of the portal page at `path`. */
export function DeakinSyncPage({ app }: { readonly app: PinnedApp }) {
  const environmentId = usePrimaryEnvironmentId();
  const [path, setPath] = useState(HOME_PATH);
  const [force, setForce] = useState(false);
  const query = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.campusDeakinsyncPage({
          environmentId,
          input: { path, ...(force ? { refresh: true } : {}) },
        })
      : null,
  );
  const data = useLastDefined(query.data);
  const issue =
    issueFromQueryError(query.error) ??
    (data?.meta.issue ? { reason: data.meta.issue, detail: data.meta.note ?? "" } : null);
  const follow = (link: PortalLink) => {
    const next = portalPath(link.href);
    if (next && !link.downloadLike) {
      setPath(next);
      return;
    }
    void readLocalApi()?.shell.openExternal(link.href);
  };
  const downloads = data?.links.filter((link) => link.downloadLike) ?? [];
  const links = data?.links.filter((link) => !link.downloadLike) ?? [];
  return (
    <CampusPage
      app={app}
      environmentId={environmentId}
      meta={data?.meta ?? null}
      issue={issue}
      loading={query.isPending}
      onRefresh={() => (force ? query.refresh() : setForce(true))}
    >
      {path !== HOME_PATH ? (
        <div className="flex items-center gap-2 pt-1 pb-3">
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Back to DeakinSync home"
            onClick={() => setPath(HOME_PATH)}
          >
            <ArrowLeftIcon />
          </Button>
          <span className="min-w-0 truncate text-sm text-muted-foreground">{path}</span>
        </div>
      ) : null}
      {data ? (
        <>
          <h2 className="pt-2 text-lg text-foreground">{data.title ?? "DeakinSync"}</h2>
          {data.headings.length > 0 ? (
            <ul className="pt-3">
              {withStableKeys(data.headings, (heading) => `${heading.level}:${heading.text}`).map(
                ([key, heading]) => (
                  <li
                    key={key}
                    className="py-0.5 text-foreground/90"
                    style={{ paddingLeft: `${Math.max(0, heading.level - 1) * 12}px` }}
                  >
                    {heading.text}
                  </li>
                ),
              )}
            </ul>
          ) : null}
          {downloads.length > 0 ? (
            <LinkGroup title="Downloads" links={downloads} onFollow={follow} />
          ) : null}
          {links.length > 0 ? <LinkGroup title="Links" links={links} onFollow={follow} /> : null}
          {data.text ? (
            <p className="whitespace-pre-wrap pt-6 text-sm text-foreground/90">{data.text}</p>
          ) : null}
        </>
      ) : null}
    </CampusPage>
  );
}

function LinkGroup({
  title,
  links,
  onFollow,
}: {
  readonly title: string;
  readonly links: ReadonlyArray<PortalLink>;
  readonly onFollow: (link: PortalLink) => void;
}) {
  return (
    <section className="pt-6">
      <h3 className="pb-1 text-sm text-muted-foreground">{title}</h3>
      <div role="list" className="flex flex-col gap-0.5">
        {withStableKeys(links, (link) => link.href).map(([key, link]) => {
          const internal = portalPath(link.href) !== null && !link.downloadLike;
          const Icon = link.downloadLike ? FileDownIcon : internal ? LinkIcon : ExternalLinkIcon;
          return (
            <div key={key} role="listitem">
              <div
                role="button"
                tabIndex={0}
                className="flex min-w-0 cursor-default items-center gap-3 rounded-lg px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onFollow(link)}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onFollow(link);
                }}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {link.text ?? link.href}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
