import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "~/env";

import { useProjectEntriesQuery } from "../components/files/projectFilesQueryState";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SpaceIcon } from "./SpaceIcon";
import {
  isPagePath,
  isVisibleEntry,
  pagesFromEntries,
  pageTitle,
  SPACE_PAGES_DIR,
  SPACE_TRASH_DIR,
  spaceAppearance,
  spaceFolderName,
  useSpaces,
  useTrashedSpaces,
} from "./spaces";
import { useSpaceActions } from "./useSpaceActions";

/** Deleted Spaces and pages, with a way back, like ChatGPT's Library trash. */
export function SpaceTrashPage() {
  const spaces = useSpaces();
  const trashed = useTrashedSpaces();
  const navigate = useNavigate();
  const { deleteSpaceForever, restoreSpace } = useSpaceActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const liveFolders = useMemo(
    () => new Set(spaces.map((space) => spaceFolderName(space.workspaceRoot))),
    [spaces],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Trash breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>Trash</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[47rem] flex-col gap-10 px-6 pt-10 pb-24">
            <section className="flex flex-col gap-2" aria-label="Spaces">
              <h2 className="text-sm font-medium text-muted-foreground">Spaces</h2>
              {trashed.length === 0 ? (
                <p className="text-base text-muted-foreground">No spaces in Trash.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {trashed.map((space) => (
                    <li
                      key={space.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-base">
                        <SpaceIcon appearance={spaceAppearance(space)} />
                        <span className="truncate">{space.title}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          size="compact"
                          variant="outline"
                          disabled={busyId === space.id}
                          onClick={async () => {
                            setBusyId(space.id);
                            const ok = await restoreSpace(space, liveFolders);
                            setBusyId(null);
                            if (ok)
                              void navigate({
                                to: "/spaces/$spaceId",
                                params: { spaceId: space.id },
                                search: {},
                              });
                          }}
                        >
                          Restore
                        </Button>
                        <Button
                          size="compact"
                          variant="ghost-destructive"
                          disabled={busyId === space.id}
                          onClick={async () => {
                            setBusyId(space.id);
                            await deleteSpaceForever(space);
                            setBusyId(null);
                          }}
                        >
                          Delete forever
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col gap-2" aria-label="Pages">
              <h2 className="text-sm font-medium text-muted-foreground">Pages</h2>
              {spaces.length === 0 ? (
                <p className="text-base text-muted-foreground">No pages in Trash.</p>
              ) : (
                spaces.map((space) => <TrashedPages key={space.id} space={space} />)
              )}
            </section>
            <p className="text-sm text-muted-foreground">
              Everything in Trash stays in the <code>.trash</code> folder of your Spaces until you
              remove it in Finder.
            </p>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

/** A Space's `.trash` holds one folder per deletion; each may hold pages or files. */
function TrashedPages({ space }: { readonly space: EnvironmentProject }) {
  const { data } = useProjectEntriesQuery(
    space.environmentId,
    space.workspaceRoot,
    SPACE_TRASH_DIR,
  );
  const stamps = useMemo(
    () =>
      (data?.entries ?? [])
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path)
        .toSorted((left, right) => right.localeCompare(left)),
    [data],
  );
  if (stamps.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {stamps.map((stamp) => (
        <TrashedStamp key={stamp} space={space} stamp={stamp} />
      ))}
    </ul>
  );
}

function TrashedStamp({
  space,
  stamp,
}: {
  readonly space: EnvironmentProject;
  readonly stamp: string;
}) {
  const { data } = useProjectEntriesQuery(space.environmentId, space.workspaceRoot, stamp);
  const livePages = useProjectEntriesQuery(
    space.environmentId,
    space.workspaceRoot,
    SPACE_PAGES_DIR,
  );
  const { restorePage } = useSpaceActions();
  const navigate = useNavigate();
  const pages = useMemo(
    () =>
      (data?.entries ?? []).filter(
        (entry) => entry.kind === "file" && isPagePath(entry.path) && isVisibleEntry(entry.path),
      ),
    [data],
  );
  const takenTitles = useMemo(
    () => new Set(pagesFromEntries(livePages.data?.entries ?? []).map((page) => page.title)),
    [livePages.data],
  );
  if (pages.length === 0) return null;
  return (
    <>
      {pages.map((page) => (
        <li
          key={page.path}
          className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
        >
          <span className="flex min-w-0 items-center gap-2 text-base">
            <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{pageTitle(page.path)}</span>
            <span className="truncate text-sm text-muted-foreground">in {space.title}</span>
          </span>
          <Button
            size="compact"
            variant="outline"
            onClick={async () => {
              if (await restorePage(space, page.path, takenTitles)) {
                void navigate({
                  to: "/spaces/$spaceId",
                  params: { spaceId: space.id },
                  search: {},
                });
              }
            }}
          >
            Restore
          </Button>
        </li>
      ))}
    </>
  );
}
