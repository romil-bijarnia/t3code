import { useLocation, useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { isElectron } from "~/env";

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { PINNED_APPS } from "./pinnedApps";

/** The sidebar's pinned web apps, above the thread list. Desktop only. */
export const SidebarPinnedApps = memo(function SidebarPinnedApps() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const activeAppId = useLocation({
    select: (location) =>
      location.pathname.startsWith("/apps/") ? location.pathname.slice("/apps/".length) : null,
  });
  if (!isElectron) return null;

  return (
    <SidebarMenu className="mb-1 grid grid-cols-2">
      {PINNED_APPS.map((app) => (
        <SidebarMenuItem key={app.id} className="min-w-0">
          <SidebarMenuButton
            isActive={activeAppId === app.id}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              void navigate({ to: "/apps/$appId", params: { appId: app.id } });
            }}
          >
            <app.icon />
            <span className="truncate">{app.name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
});
