import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback } from "react";

import { usePrimaryEnvironment, usePullRequestsSupported } from "../../state/environments";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { useSidebar } from "../ui/sidebar";

/**
 * The bottom of the sidebar, as in Codex: an avatar, the name of what you are
 * connected to, and a menu with the app's own pages.
 */
export const SidebarProfileRow = memo(function SidebarProfileRow() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const environment = usePrimaryEnvironment();
  const pullRequestsSupported = usePullRequestsSupported();
  const name = environment?.label?.trim() || "Local";
  const initial = name.charAt(0).toUpperCase();

  const go = useCallback(
    (to: "/settings" | "/settings/keybindings" | "/usage" | "/pull-requests") => {
      if (isMobile) setOpenMobile(false);
      if (to === "/pull-requests") {
        void navigate({ to, search: readPullRequestListPreferences() });
        return;
      }
      void navigate({ to });
    },
    [isMobile, navigate, setOpenMobile],
  );

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Open profile menu"
            className="flex h-11 w-full min-w-0 items-center gap-2.5 rounded-(--control-radius) px-2 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover"
          />
        }
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-foreground text-xs font-semibold text-sidebar"
        >
          {initial}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base leading-5 text-sidebar-foreground">{name}</span>
          <span className="truncate text-xs leading-4 text-sidebar-muted-foreground">
            {environment ? "Connected" : "Not connected"}
          </span>
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="top" sideOffset={8}>
        <MenuItem onClick={() => go("/settings")}>
          Settings
          <MenuShortcut>⌘,</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={() => go("/settings/keybindings")}>Keyboard shortcuts</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => go("/usage")}>Usage</MenuItem>
        {pullRequestsSupported ? (
          <MenuItem onClick={() => go("/pull-requests")}>Pull requests</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
