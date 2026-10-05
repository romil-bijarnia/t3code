import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  HouseIcon,
  RotateCwIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";

import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { findPinnedApp, pinnedAppWebview, usePinnedAppsStore } from "./pinnedApps";

/** Full-height page for one pinned app. The webview itself lives in `PinnedAppsHost`. */
export function PinnedAppPage({ appId }: { readonly appId: string }) {
  const app = findPinnedApp(appId);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const navigation = usePinnedAppsStore((state) => state.navigationById[appId]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || !app || !isElectron) return;
    const present = () => {
      const rect = slot.getBoundingClientRect();
      usePinnedAppsStore.getState().present(app.id, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    present();
    const observer = new ResizeObserver(present);
    observer.observe(slot);
    window.addEventListener("resize", present);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", present);
      usePinnedAppsStore.getState().hide(app.id);
    };
  }, [app]);

  const webview = () => pinnedAppWebview(appId);
  const openInBrowser = () => {
    const url = navigation?.url ?? app?.url;
    if (url) void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="App breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem>
              <h1>{app?.name ?? "App"}</h1>
            </WorkspaceBreadcrumbItem>
            {navigation?.title ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current className="min-w-0">
                  <WorkspaceBreadcrumbText className="truncate">
                    {navigation.title}
                  </WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          {app && isElectron ? (
            <div className="flex shrink-0 items-center gap-0.5">
              <ToolbarButton
                label="Back"
                disabled={!navigation?.canGoBack}
                onClick={() => webview()?.goBack()}
              >
                <ArrowLeftIcon />
              </ToolbarButton>
              <ToolbarButton
                label="Forward"
                disabled={!navigation?.canGoForward}
                onClick={() => webview()?.goForward()}
              >
                <ArrowRightIcon />
              </ToolbarButton>
              <ToolbarButton label="Reload" onClick={() => webview()?.reload()}>
                <RotateCwIcon />
              </ToolbarButton>
              <ToolbarButton
                label={`${app.name} home`}
                onClick={() => void webview()?.loadURL(app.url)}
              >
                <HouseIcon />
              </ToolbarButton>
              <ToolbarButton label="Open in browser" onClick={openInBrowser}>
                <ExternalLinkIcon />
              </ToolbarButton>
            </div>
          ) : null}
        </WorkspacePageHeader>
        <div ref={slotRef} className="relative min-h-0 flex-1 border-t border-border">
          {!app ? (
            <p className="p-6 text-sm text-muted-foreground">This app is not pinned.</p>
          ) : !isElectron ? (
            <p className="p-6 text-sm text-muted-foreground">
              Pinned apps open in the desktop app.
            </p>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            size="icon-xs"
            variant="ghost"
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
