import { DeakinSyncPage } from "../campus/DeakinSyncPage";
import { OnTrackPage } from "../campus/OnTrackPage";
import { OutlookPage } from "../campus/OutlookPage";
import { TeamsPage } from "../campus/TeamsPage";
import { SidebarInset } from "../components/ui/sidebar";
import { findPinnedApp } from "./pinnedApps";

/** One pinned app as a page of the app itself, read through the campus service. */
export function PinnedAppPage({ appId }: { readonly appId: string }) {
  const app = findPinnedApp(appId);
  switch (app?.id) {
    case "ontrack":
      return <OnTrackPage app={app} />;
    case "deakinsync":
      return <DeakinSyncPage app={app} />;
    case "teams":
      return <TeamsPage app={app} />;
    case "outlook":
      return <OutlookPage app={app} />;
    default:
      return (
        <SidebarInset className="h-dvh min-h-0 overflow-hidden">
          <p className="p-6 text-sm text-muted-foreground">This app is not pinned.</p>
        </SidebarInset>
      );
  }
}
