import { createFileRoute } from "@tanstack/react-router";

import { PinnedAppPage } from "../pinnedApps/PinnedAppPage";

export const Route = createFileRoute("/apps/$appId")({
  component: PinnedAppRoute,
});

function PinnedAppRoute() {
  const { appId } = Route.useParams();
  return <PinnedAppPage key={appId} appId={appId} />;
}
