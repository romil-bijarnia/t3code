import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, EllipsisIcon, FileTextIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { NewSpaceDialog } from "../../spaces/NewSpaceDialog";
import { DeleteDialog, RenameDialog } from "../../spaces/SpaceDialogs";
import { SpaceIcon } from "../../spaces/SpaceIcon";
import {
  pageChildrenDir,
  pagesFromEntries,
  SPACE_INSTRUCTIONS_FILE,
  SPACE_ROOT_PAGE,
  spaceAppearance,
  type SpacePageNode,
  useSpaces,
} from "../../spaces/spaces";
import { useSpaceTreeExpanded } from "../../spaces/spaceTreeState";
import { useSpaceActions } from "../../spaces/useSpaceActions";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjectEntriesQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ActiveSpaceLocation {
  readonly spaceId: string;
  readonly page: string | null;
}

type PendingDialog =
  | { readonly kind: "rename-space"; readonly space: EnvironmentProject }
  | { readonly kind: "delete-space"; readonly space: EnvironmentProject }
  | {
      readonly kind: "rename-page";
      readonly space: EnvironmentProject;
      readonly page: SpacePageNode;
    }
  | {
      readonly kind: "delete-page";
      readonly space: EnvironmentProject;
      readonly page: SpacePageNode;
    };

/**
 * The Spaces section of the sidebar, after ChatGPT: each Space unfolds into
 * its page tree, rows grow a "…" menu and a plus on hover, and Trash sits at
 * the bottom.
 */
export const SidebarSpaces = memo(function SidebarSpaces() {
  const spaces = useSpaces();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [dialogOpen, setDialogOpen] = useState(false);
  // A fresh key per opening gives the dialog empty fields every time.
  const [dialogKey, setDialogKey] = useState(0);
  const [pending, setPending] = useState<PendingDialog | null>(null);
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

  const openDialog = useCallback(() => {
    setDialogKey((key) => key + 1);
    setDialogOpen(true);
  }, []);

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

  const openTrash = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/spaces/trash" });
  }, [isMobile, navigate, setOpenMobile]);

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
                  aria-label="New space"
                  onClick={openDialog}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="right">New space</TooltipPopup>
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
            onDialog={setPending}
          />
        ))}
        {spaces.length === 0 ? (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={openDialog}>
              <PlusIcon />
              <span>New space</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        <SidebarMenuItem>
          <SidebarMenuButton isActive={pathname === "/spaces/trash"} onClick={openTrash}>
            <Trash2Icon />
            <span>Trash</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <NewSpaceDialog
        key={dialogKey}
        environmentId={primaryEnvironmentId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(spaceId) => openSpace(spaceId)}
      />
      {pending ? (
        <PendingSpaceDialog pending={pending} onClose={() => setPending(null)} onOpen={openSpace} />
      ) : null}
    </SidebarGroup>
  );
});

function PendingSpaceDialog({
  pending,
  onClose,
  onOpen,
}: {
  readonly pending: PendingDialog;
  readonly onClose: () => void;
  readonly onOpen: (spaceId: string, page?: string) => void;
}) {
  const navigate = useNavigate();
  const { deletePage, deleteSpace, renamePage, renameSpace } = useSpaceActions();
  const pathname = useLocation({ select: (location) => location.pathname });
  switch (pending.kind) {
    case "rename-space":
      return (
        <RenameDialog
          kind="space"
          initialValue={pending.space.title}
          onClose={onClose}
          onSave={(value) => renameSpace(pending.space, value)}
        />
      );
    case "delete-space":
      return (
        <DeleteDialog
          kind="space"
          title={pending.space.title}
          onClose={onClose}
          onConfirm={async () => {
            if (
              (await deleteSpace(pending.space)) &&
              pathname.startsWith(`/spaces/${pending.space.id}`)
            ) {
              void navigate({ to: "/" });
            }
          }}
        />
      );
    case "rename-page":
      return (
        <RenameDialog
          kind="page"
          initialValue={pending.page.title}
          onClose={onClose}
          onSave={async (value) => {
            const next = await renamePage(
              pending.space,
              pending.page.relativePath,
              value,
              pending.page.hasChildren,
            );
            if (next && next !== pending.page.relativePath) onOpen(pending.space.id, next);
          }}
        />
      );
    case "delete-page":
      return (
        <DeleteDialog
          kind="page"
          title={pending.page.title}
          onClose={onClose}
          onConfirm={async () => {
            if (
              await deletePage(pending.space, pending.page.relativePath, pending.page.hasChildren)
            ) {
              onOpen(pending.space.id);
            }
          }}
        />
      );
  }
}

const SidebarSpaceRow = memo(function SidebarSpaceRow({
  space,
  active,
  onOpen,
  onDialog,
}: {
  readonly space: EnvironmentProject;
  readonly active: ActiveSpaceLocation | null;
  readonly onOpen: (spaceId: string, page?: string) => void;
  readonly onDialog: (pending: PendingDialog) => void;
}) {
  const { handleNewThread } = useHandleNewThread();
  const { createPage } = useSpaceActions();
  const [expanded, setExpanded] = useSpaceTreeExpanded(`${space.id}`, active !== null);
  const pages = usePages(space, SPACE_ROOT_PAGE);
  const isRootActive = active !== null && active.page === null;

  const addPage = async () => {
    const created = await createPage(space, SPACE_ROOT_PAGE, new Set(pages.map((p) => p.title)));
    if (created) {
      setExpanded(true);
      onOpen(space.id, created);
    }
  };

  return (
    <SidebarMenuItem>
      <TreeRow
        isActive={isRootActive}
        level={0}
        hasChildren
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        onClick={() => onOpen(space.id)}
        icon={<SpaceIcon appearance={spaceAppearance(space)} />}
        label={space.title}
        menuLabel={`Space actions for ${space.title}`}
        plusLabel={`Add page to ${space.title}`}
        onPlus={() => void addPage()}
        menu={
          <>
            <MenuItem onClick={() => onDialog({ kind: "rename-space", space })}>Rename</MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => void addPage()}>New page</MenuItem>
            <MenuItem
              onClick={() => void handleNewThread(scopeProjectRef(space.environmentId, space.id))}
            >
              New chat
            </MenuItem>
            <MenuItem onClick={() => onOpen(space.id, SPACE_INSTRUCTIONS_FILE)}>
              Assistant instructions
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              onClick={() => onDialog({ kind: "delete-space", space })}
            >
              Delete
            </MenuItem>
          </>
        }
      />
      {expanded ? (
        <PageTree
          space={space}
          parentPath={SPACE_ROOT_PAGE}
          level={1}
          active={active}
          onOpen={onOpen}
          onDialog={onDialog}
        />
      ) : null}
    </SidebarMenuItem>
  );
});

function usePages(space: EnvironmentProject, parentPath: string): ReadonlyArray<SpacePageNode> {
  const { data } = useProjectEntriesQuery(
    space.environmentId,
    space.workspaceRoot,
    pageChildrenDir(parentPath),
  );
  return useMemo(() => pagesFromEntries(data?.entries ?? []), [data]);
}

function PageTree({
  space,
  parentPath,
  level,
  active,
  onOpen,
  onDialog,
}: {
  readonly space: EnvironmentProject;
  readonly parentPath: string;
  readonly level: number;
  readonly active: ActiveSpaceLocation | null;
  readonly onOpen: (spaceId: string, page?: string) => void;
  readonly onDialog: (pending: PendingDialog) => void;
}) {
  const pages = usePages(space, parentPath);
  if (pages.length === 0) {
    return (
      <div
        className="flex h-8 items-center text-base text-sidebar-muted-foreground/60 select-none"
        style={{ paddingLeft: `calc(var(--sidebar-row-content-inset) + ${level * 1.25}rem)` }}
      >
        No pages
      </div>
    );
  }
  return (
    <ul className="flex min-w-0 flex-col gap-px">
      {pages.map((page) => (
        <PageRow
          key={page.relativePath}
          space={space}
          page={page}
          level={level}
          active={active}
          onOpen={onOpen}
          onDialog={onDialog}
        />
      ))}
    </ul>
  );
}

function PageRow({
  space,
  page,
  level,
  active,
  onOpen,
  onDialog,
}: {
  readonly space: EnvironmentProject;
  readonly page: SpacePageNode;
  readonly level: number;
  readonly active: ActiveSpaceLocation | null;
  readonly onOpen: (spaceId: string, page?: string) => void;
  readonly onDialog: (pending: PendingDialog) => void;
}) {
  const { createPage } = useSpaceActions();
  const [expanded, setExpanded] = useSpaceTreeExpanded(`${space.id}:${page.relativePath}`, false);
  const isActive = active?.page === page.relativePath;
  const isAncestorOfActive =
    active?.page !== null &&
    active?.page !== undefined &&
    active.page.startsWith(`${pageChildrenDir(page.relativePath)}/`);
  const showChildren = page.hasChildren && (expanded || isAncestorOfActive);

  const addSubpage = async () => {
    const created = await createPage(space, page.relativePath, new Set());
    if (created) {
      setExpanded(true);
      onOpen(space.id, created);
    }
  };

  return (
    <li>
      <TreeRow
        isActive={isActive}
        level={level}
        hasChildren={page.hasChildren}
        expanded={showChildren}
        onToggle={() => setExpanded(!showChildren)}
        onClick={() => onOpen(space.id, page.relativePath)}
        icon={<FileTextIcon className="size-4 text-sidebar-muted-foreground" />}
        label={page.title}
        menuLabel={`Page actions for ${page.title}`}
        plusLabel={`Add subpage to ${page.title}`}
        onPlus={() => void addSubpage()}
        menu={
          <>
            <MenuItem onClick={() => onDialog({ kind: "rename-page", space, page })}>
              Rename
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => void addSubpage()}>New page</MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              onClick={() => onDialog({ kind: "delete-page", space, page })}
            >
              Delete
            </MenuItem>
          </>
        }
      />
      {showChildren ? (
        <PageTree
          space={space}
          parentPath={page.relativePath}
          level={level + 1}
          active={active}
          onOpen={onOpen}
          onDialog={onDialog}
        />
      ) : null}
    </li>
  );
}

/**
 * One tree row: the icon turns into a chevron on hover when there is
 * something to unfold, and the "…" menu and plus appear on hover.
 */
function TreeRow({
  isActive,
  level,
  hasChildren,
  expanded,
  onToggle,
  onClick,
  icon,
  label,
  menu,
  menuLabel,
  plusLabel,
  onPlus,
}: {
  readonly isActive: boolean;
  readonly level: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onClick: () => void;
  readonly icon: ReactNode;
  readonly label: string;
  readonly menu: ReactNode;
  readonly menuLabel: string;
  readonly plusLabel: string;
  readonly onPlus: () => void;
}) {
  return (
    <div className="group/tree-row relative">
      <SidebarMenuButton
        isActive={isActive}
        // A div, so the chevron inside can be a real button.
        render={<div role="button" tabIndex={0} />}
        style={{ paddingLeft: `calc(var(--sidebar-row-content-inset) + ${level * 1.25}rem)` }}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
          if (event.key === "ArrowRight" && hasChildren && !expanded) onToggle();
          if (event.key === "ArrowLeft" && hasChildren && expanded) onToggle();
        }}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <span className={cn("flex", hasChildren && "group-hover/tree-row:hidden")}>{icon}</span>
          {hasChildren ? (
            <button
              type="button"
              aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
              className="absolute inset-0 hidden items-center justify-center rounded-sm text-sidebar-muted-foreground hover:text-sidebar-foreground group-hover/tree-row:flex"
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
            >
              <ChevronRightIcon
                className={cn("size-4 transition-transform duration-150", expanded && "rotate-90")}
              />
            </button>
          ) : null}
        </span>
        <span className="truncate">{label}</span>
        <span aria-hidden className="w-12 shrink-0" />
      </SidebarMenuButton>
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center opacity-0 transition-opacity duration-150 group-focus-within/tree-row:opacity-100 group-hover/tree-row:opacity-100 has-[[data-popup-open]]:opacity-100 max-sm:opacity-100">
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost-muted" aria-label={menuLabel} />}
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start">{menu}</MenuPopup>
        </Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={plusLabel}
                onClick={onPlus}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">{plusLabel}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
