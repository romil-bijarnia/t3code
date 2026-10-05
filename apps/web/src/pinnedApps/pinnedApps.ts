import { PINNED_APP_TAB_ID_PREFIX } from "@t3tools/contracts";
import {
  ClipboardCheckIcon,
  GraduationCapIcon,
  MailIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { create } from "zustand";

export interface PinnedApp {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly icon: LucideIcon;
}

/** Web apps pinned to the sidebar. Each keeps one live desktop webview once opened. */
export const PINNED_APPS: ReadonlyArray<PinnedApp> = [
  {
    id: "ontrack",
    name: "OnTrack",
    url: "https://ontrack.deakin.edu.au/home",
    icon: ClipboardCheckIcon,
  },
  {
    id: "deakinsync",
    name: "DeakinSync",
    url: "https://sync.deakin.edu.au/home",
    icon: GraduationCapIcon,
  },
  { id: "teams", name: "Teams", url: "https://teams.cloud.microsoft/", icon: UsersIcon },
  { id: "outlook", name: "Outlook", url: "https://outlook.cloud.microsoft/mail/", icon: MailIcon },
];

export const findPinnedApp = (id: string): PinnedApp | undefined =>
  PINNED_APPS.find((app) => app.id === id);

export const pinnedAppTabId = (id: string): string => `${PINNED_APP_TAB_ID_PREFIX}${id}`;

/**
 * Electron's default user agent names Electron and the app, which Microsoft
 * sign-in treats as an unsupported browser. Pinned apps present as the Chrome
 * build they actually run on, so client hints still agree with it.
 */
export function browserUserAgent(userAgent: string): string {
  const chromeVersion = /Chrome\/([\d.]+)/.exec(userAgent)?.[1];
  const prefix = /^.*?\(KHTML, like Gecko\)/.exec(userAgent)?.[0];
  return chromeVersion && prefix ? `${prefix} Chrome/${chromeVersion} Safari/537.36` : userAgent;
}

export interface PinnedAppRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PinnedAppNavigation {
  readonly url: string | null;
  readonly title: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
}

interface PinnedAppsState {
  /** Apps whose webview is mounted. Opening is one-way so a revisit is instant. */
  readonly openedIds: ReadonlyArray<string>;
  readonly activeId: string | null;
  readonly rect: PinnedAppRect | null;
  readonly navigationById: Readonly<Record<string, PinnedAppNavigation>>;
  readonly present: (id: string, rect: PinnedAppRect) => void;
  readonly hide: (id: string) => void;
  readonly setNavigation: (id: string, navigation: PinnedAppNavigation) => void;
}

export const usePinnedAppsStore = create<PinnedAppsState>()((set) => ({
  openedIds: [],
  activeId: null,
  rect: null,
  navigationById: {},
  present: (id, rect) =>
    set((state) => ({
      openedIds: state.openedIds.includes(id) ? state.openedIds : [...state.openedIds, id],
      activeId: id,
      rect,
    })),
  hide: (id) => set((state) => (state.activeId === id ? { activeId: null } : state)),
  setNavigation: (id, navigation) =>
    set((state) => ({ navigationById: { ...state.navigationById, [id]: navigation } })),
}));

/** The renderer-side `<webview>` methods pinned apps drive directly. */
export interface PinnedAppWebviewElement extends HTMLElement {
  getWebContentsId: () => number;
  getURL: () => string;
  getTitle: () => string;
  isLoading: () => boolean;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadURL: (url: string) => Promise<void>;
}

const webviewsById = new Map<string, PinnedAppWebviewElement>();

export function registerPinnedAppWebview(id: string, webview: PinnedAppWebviewElement) {
  webviewsById.set(id, webview);
  return () => {
    if (webviewsById.get(id) === webview) webviewsById.delete(id);
  };
}

export const pinnedAppWebview = (id: string): PinnedAppWebviewElement | undefined =>
  webviewsById.get(id);
