import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { useRouter } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useProjects, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Pinned threads from every project, above the project tree. Pin and unpin
 * live in a thread's context menu; the section is absent until one is pinned.
 */
export const SidebarPinnedThreads = memo(function SidebarPinnedThreads({
  activeThreadKey,
}: {
  readonly activeThreadKey: string | null;
}) {
  const threads = useThreadShells();
  const projects = useProjects();
  const pinnedThreads = useMemo(
    () =>
      sortPinnedThreadsByOrderKey(
        threads.filter((thread) => thread.pinnedAt !== null && thread.archivedAt === null),
      ),
    [threads],
  );
  if (pinnedThreads.length === 0) return null;

  return (
    <SidebarGroup>
      <div className="flex h-8 items-center pl-(--sidebar-row-content-inset) text-base text-sidebar-muted-foreground">
        Pinned
      </div>
      <SidebarMenu>
        {pinnedThreads.map((thread) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          const project = projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          );
          return (
            <SidebarThreadRow
              key={threadKey}
              thread={thread}
              isActive={activeThreadKey === threadKey}
              projectCwd={thread.worktreePath ?? project?.workspaceRoot ?? null}
            />
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
});

/** One thread row outside the project tree; the pinned list and the flat Chats list share it. */
export const SidebarThreadRow = memo(function SidebarThreadRow({
  thread,
  isActive,
  projectCwd,
}: {
  readonly thread: SidebarThreadSummary;
  readonly isActive: boolean;
  readonly projectCwd: string | null;
}) {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  // Null while not renaming; otherwise the title being edited in place.
  const [renamingTitle, setRenamingTitle] = useState<string | null>(null);
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const startRename = useCallback(() => setRenamingTitle(thread.title), [thread.title]);
  const { openMenu } = useThreadActionMenu({ threadRef, projectCwd, onStartRename: startRename });
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
    },
  });

  const openThread = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  }, [isMobile, router, setOpenMobile, threadRef]);

  const commitRename = useCallback(async () => {
    const title = renamingTitle?.trim() ?? "";
    setRenamingTitle(null);
    if (title.length === 0 || title === thread.title) return;
    const result = await updateThreadMetadata({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, title },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [renamingTitle, thread.title, threadRef, updateThreadMetadata]);

  if (renamingTitle !== null) {
    return (
      <SidebarMenuItem>
        <input
          aria-label="Thread title"
          autoFocus
          className="h-8 w-full min-w-0 rounded-(--control-radius) border border-ring bg-transparent px-(--sidebar-row-content-inset) text-base text-sidebar-foreground outline-none"
          value={renamingTitle}
          onBlur={() => void commitRename()}
          onChange={(event) => setRenamingTitle(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commitRename();
            if (event.key === "Escape") setRenamingTitle(null);
          }}
        />
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={openThread}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
        <span className="pr-6">{thread.title}</span>
      </SidebarMenuButton>
      <span className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/menu-item:opacity-100 focus-within:opacity-100">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Chat actions"
          aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <EllipsisIcon />
        </Button>
      </span>
    </SidebarMenuItem>
  );
});
