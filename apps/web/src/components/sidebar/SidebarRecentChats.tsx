import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo, useMemo, useState } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { SidebarThreadRow } from "./SidebarPinnedThreads";

const PAGE_SIZE = 10;
const MAX_CHATS = 50;

/**
 * The flat Chats list from Codex: every live thread, newest first, ten at a
 * time with Show more, under the project tree.
 */
export const SidebarRecentChats = memo(function SidebarRecentChats({
  activeThreadKey,
}: {
  readonly activeThreadKey: string | null;
}) {
  const threads = useThreadShells();
  const projects = useProjects();
  const [shown, setShown] = useState(PAGE_SIZE);
  const chats = useMemo(
    () =>
      threads
        .filter((thread) => thread.archivedAt === null)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_CHATS),
    [threads],
  );
  if (chats.length === 0) return null;
  const visible = chats.slice(0, shown);

  return (
    <SidebarGroup>
      <div className="flex h-8 items-center pl-(--sidebar-row-content-inset) text-base text-sidebar-muted-foreground">
        Chats
      </div>
      <SidebarMenu>
        {visible.map((thread) => {
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
        {shown < chats.length ? (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setShown((count) => count + PAGE_SIZE)}>
              <span className="text-sidebar-muted-foreground">Show more</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : shown > PAGE_SIZE ? (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setShown(PAGE_SIZE)}>
              <span className="text-sidebar-muted-foreground">Show less</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  );
});
