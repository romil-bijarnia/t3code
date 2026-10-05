import { useLocation, useNavigate } from "@tanstack/react-router";
import { SquarePenIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { isElectron } from "~/env";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { PINNED_APPS, type PinnedApp } from "../../pinnedApps/pinnedApps";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The top of the thread sidebar: start a chat, or jump to a pinned app. */
export const SidebarPrimaryNav = memo(function SidebarPrimaryNav({
  newThreadShortcutLabel,
}: {
  readonly newThreadShortcutLabel: string | null;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const activeAppId = useLocation({
    select: (location) =>
      location.pathname.startsWith("/apps/") ? location.pathname.slice("/apps/".length) : null,
  });

  // Goes straight to the new-chat screen in the project you are in. Its
  // heading is where you pick a different project.
  const startNewChat = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void startNewThreadFromContext({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
  }, [
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    isMobile,
    setOpenMobile,
  ]);

  const openApp = useCallback(
    (app: PinnedApp) => {
      if (isMobile) setOpenMobile(false);
      // Only the desktop app can host the page; elsewhere it is a plain link.
      if (!isElectron) {
        window.open(app.url, "_blank", "noopener,noreferrer");
        return;
      }
      void navigate({ to: "/apps/$appId", params: { appId: app.id } });
    },
    [isMobile, navigate, setOpenMobile],
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Tooltip>
          <TooltipTrigger
            render={<SidebarMenuButton data-testid="sidebar-new-chat" onClick={startNewChat} />}
          >
            <SquarePenIcon />
            <span>New chat</span>
          </TooltipTrigger>
          {newThreadShortcutLabel ? (
            <TooltipPopup side="right">{newThreadShortcutLabel}</TooltipPopup>
          ) : null}
        </Tooltip>
      </SidebarMenuItem>
      {PINNED_APPS.map((app) => (
        <SidebarMenuItem key={app.id}>
          <SidebarMenuButton isActive={activeAppId === app.id} onClick={() => openApp(app)}>
            <app.icon />
            <span>{app.name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
});
