import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { FileTextIcon, PlusIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { NewSpaceDialog } from "../../spaces/NewSpaceDialog";
import { isVisibleEntry, pageTitle, SPACE_PAGES_DIR, useSpaces } from "../../spaces/spaces";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjectEntriesQuery } from "../files/projectFilesQueryState";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ActiveSpaceLocation {
  readonly spaceId: string;
  readonly page: string | null;
}

/**
 * Spaces above the project tree. The open Space unfolds to show its pages,
 * the way a Space does in the ChatGPT sidebar.
 */
export const SidebarSpaces = memo(function SidebarSpaces() {
  const spaces = useSpaces();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [dialogOpen, setDialogOpen] = useState(false);
  // A fresh key per opening gives the dialog empty fields every time.
  const [dialogKey, setDialogKey] = useState(0);
  const openDialog = useCallback(() => {
    setDialogKey((key) => key + 1);
    setDialogOpen(true);
  }, []);
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = useLocation({ select: (location) => location.search });
  const active = useMemo<ActiveSpaceLocation | null>(() => {
    if (!pathname.startsWith("/spaces/")) return null;
    const page = (search as { page?: unknown }).page;
    return {
      spaceId: decodeURIComponent(pathname.slice("/spaces/".length)),
      page: typeof page === "string" ? page : null,
    };
  }, [pathname, search]);

  const openSpace = useCallback(
    (spaceId: string, page?: string) => {
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/spaces/$spaceId",
        params: { spaceId },
        search: page ? { page } : {},
      });
    },
    [isMobile, navigate, setOpenMobile],
  );

  return (
    <SidebarGroup>
      <div className="group/spaces-heading flex h-8 items-center justify-between pr-1.5 pl-(--sidebar-row-content-inset)">
        <span className="text-base text-sidebar-muted-foreground">Spaces</span>
        <div className="opacity-0 transition-opacity duration-150 group-focus-within/spaces-heading:opacity-100 group-hover/spaces-heading:opacity-100 max-sm:opacity-100 has-[[data-popup-open]]:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="New Space"
                  onClick={openDialog}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="right">New Space</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <SidebarMenu>
        {spaces.map((space) => (
          <SidebarSpaceRow
            key={`${space.environmentId}:${space.id}`}
            space={space}
            active={active?.spaceId === space.id ? active : null}
            onOpen={openSpace}
          />
        ))}
        {spaces.length === 0 ? (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={openDialog}>
              <PlusIcon />
              <span>New Space</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
      <NewSpaceDialog
        key={dialogKey}
        environmentId={primaryEnvironmentId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(spaceId) => openSpace(spaceId)}
      />
    </SidebarGroup>
  );
});

const SidebarSpaceRow = memo(function SidebarSpaceRow({
  space,
  active,
  onOpen,
}: {
  readonly space: EnvironmentProject;
  readonly active: ActiveSpaceLocation | null;
  readonly onOpen: (spaceId: string, page?: string) => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active !== null && active.page === null}
        onClick={() => onOpen(space.id)}
      >
        <ProjectFavicon project={space} className="size-4" />
        <span>{space.title}</span>
      </SidebarMenuButton>
      {active ? <SidebarSpacePages space={space} activePage={active.page} onOpen={onOpen} /> : null}
    </SidebarMenuItem>
  );
});

function SidebarSpacePages({
  space,
  activePage,
  onOpen,
}: {
  readonly space: EnvironmentProject;
  readonly activePage: string | null;
  readonly onOpen: (spaceId: string, page?: string) => void;
}) {
  const { data } = useProjectEntriesQuery(
    space.environmentId,
    space.workspaceRoot,
    SPACE_PAGES_DIR,
  );
  const pages = useMemo(
    () =>
      (data?.entries ?? [])
        .filter((entry) => entry.kind === "file" && isVisibleEntry(entry.path))
        .filter((entry) => entry.path.toLowerCase().endsWith(".md"))
        .map((entry) => entry.path)
        .toSorted((left, right) => pageTitle(left).localeCompare(pageTitle(right))),
    [data],
  );
  if (pages.length === 0) return null;

  return (
    <SidebarMenuSub className="ml-5">
      {pages.map((page) => (
        <SidebarMenuItem key={page}>
          <SidebarMenuButton isActive={activePage === page} onClick={() => onOpen(space.id, page)}>
            <FileTextIcon />
            <span>{pageTitle(page)}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenuSub>
  );
}
