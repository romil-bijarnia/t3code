"use client";

import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { acquireDesktopTab, type AcquiredDesktopTab } from "~/browser/desktopTabLifetime";
import { HIDDEN_BROWSER_WEBVIEW_OFFSET } from "~/browser/hostedBrowserWebviewStyle";
import { usePreviewWebviewConfig } from "~/browser/previewWebviewConfigState";
import { previewBridge } from "~/components/preview/previewBridge";
import { isElectron } from "~/env";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";

import {
  browserUserAgent,
  findPinnedApp,
  pinnedAppTabId,
  registerPinnedAppWebview,
  usePinnedAppsStore,
  type PinnedApp,
  type PinnedAppWebviewElement,
} from "./pinnedApps";

const USER_AGENT = typeof navigator === "undefined" ? "" : browserUserAgent(navigator.userAgent);

/**
 * Mounted once beside the preview browser host, outside the router, so a
 * pinned app keeps its page and login while you move between threads.
 */
export function PinnedAppsHost() {
  const openedIds = usePinnedAppsStore((state) => state.openedIds);
  const environmentId = usePrimaryEnvironmentId();
  if (!isElectron || !environmentId) return null;
  return (
    <div className="contents" data-pinned-apps-host>
      {openedIds.map((id) => {
        const app = findPinnedApp(id);
        return app ? <PinnedAppWebview key={id} app={app} environmentId={environmentId} /> : null;
      })}
    </div>
  );
}

function PinnedAppWebview({
  app,
  environmentId,
}: {
  readonly app: PinnedApp;
  readonly environmentId: EnvironmentId;
}) {
  const hydrated = useClientSettingsHydrated();
  // The default profile, so a thread's preview tab shares these logins.
  const config = usePreviewWebviewConfig(environmentId);
  const tabId = pinnedAppTabId(app.id);
  const { active, rect } = usePinnedAppsStore(
    useShallow((state) => ({ active: state.activeId === app.id, rect: state.rect })),
  );
  const leaseRef = useRef<AcquiredDesktopTab | null>(null);
  const webviewRef = useRef<PinnedAppWebviewElement | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    const lease = acquireDesktopTab(tabId);
    leaseRef.current = lease;
    return () => {
      if (leaseRef.current === lease) leaseRef.current = null;
      lease.release();
    };
  }, [hydrated, tabId]);

  useEffect(() => {
    const webview = webviewRef.current;
    const bridge = previewBridge;
    if (!webview || !config || !bridge) return;
    let disposed = false;
    // Registration installs the desktop popup handler that sign-in needs.
    const register = () => {
      const lease = leaseRef.current;
      if (!lease) return;
      void lease.ready
        .then(async () => {
          if (disposed) return;
          const webContentsId = webview.getWebContentsId();
          if (Number.isInteger(webContentsId) && webContentsId > 0) {
            await bridge.registerWebview(tabId, webContentsId);
          }
        })
        .catch(() => undefined);
    };
    const syncNavigation = () => {
      try {
        usePinnedAppsStore.getState().setNavigation(app.id, {
          url: webview.getURL(),
          title: webview.getTitle(),
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward(),
          loading: webview.isLoading(),
        });
      } catch {
        // Not attached yet; dom-ready syncs again.
      }
    };
    const navigationEvents = [
      "did-navigate",
      "did-navigate-in-page",
      "did-start-loading",
      "did-stop-loading",
      "page-title-updated",
      "dom-ready",
    ];
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    for (const event of navigationEvents) webview.addEventListener(event, syncNavigation);
    const unregister = registerPinnedAppWebview(app.id, webview);
    register();
    return () => {
      disposed = true;
      unregister();
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
      for (const event of navigationEvents) webview.removeEventListener(event, syncNavigation);
    };
  }, [app.id, config, tabId]);

  if (!hydrated || !config) return null;

  // Inactive guests stay paintable offscreen: Electron can permanently blank a
  // macOS webview after `visibility: hidden`.
  const style =
    active && rect
      ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 30 }
      : {
          left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
          top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
          width: rect?.width ?? 1280,
          height: rect?.height ?? 800,
          zIndex: -1,
          pointerEvents: "none" as const,
        };

  return (
    <div
      className="fixed overflow-hidden bg-background"
      style={style}
      aria-hidden={active ? undefined : true}
      data-pinned-app={app.id}
    >
      <webview
        ref={(node: HTMLElement | null) => {
          webviewRef.current = node as PinnedAppWebviewElement | null;
        }}
        // A string attribute on the element itself, for the same reason as the
        // preview webview: Electron reads it at attach and react-dom drops booleans.
        {...({ allowpopups: "true" } as unknown as { readonly allowpopups?: boolean })}
        src={app.url}
        partition={config.partition}
        webpreferences={config.webPreferences}
        {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
        {...(USER_AGENT ? { useragent: USER_AGENT } : {})}
        className="flex size-full"
      />
    </div>
  );
}
