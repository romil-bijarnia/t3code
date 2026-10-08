import {
  ClipboardCheckIcon,
  GraduationCapIcon,
  MailIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

export interface PinnedApp {
  readonly id: string;
  readonly name: string;
  /** The website the page stands in for; "Open in browser" goes here. */
  readonly url: string;
  readonly icon: LucideIcon;
}

/** Campus apps pinned to the sidebar, each shown as a page of this app. */
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

/**
 * Electron's default user agent names Electron and the app, which Microsoft
 * sign-in treats as an unsupported browser. Anything that still opens a web
 * view of these sites presents as the Chrome build it actually runs on.
 */
export function browserUserAgent(userAgent: string): string {
  const chromeVersion = /Chrome\/([\d.]+)/.exec(userAgent)?.[1];
  const prefix = /^.*?\(KHTML, like Gecko\)/.exec(userAgent)?.[0];
  return chromeVersion && prefix ? `${prefix} Chrome/${chromeVersion} Safari/537.36` : userAgent;
}
