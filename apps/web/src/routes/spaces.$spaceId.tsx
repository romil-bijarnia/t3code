import { createFileRoute } from "@tanstack/react-router";

import { SpacePage } from "../spaces/SpacePage";
import { SPACE_TABS, type SpaceTab } from "../spaces/spaces";

export interface SpaceSearch {
  readonly page?: string;
  readonly tab?: SpaceTab;
}

export const Route = createFileRoute("/spaces/$spaceId")({
  validateSearch: (raw: Record<string, unknown>): SpaceSearch => ({
    ...(typeof raw.page === "string" && raw.page.trim() ? { page: raw.page } : {}),
    ...(typeof raw.tab === "string" && (SPACE_TABS as ReadonlyArray<string>).includes(raw.tab)
      ? { tab: raw.tab as SpaceTab }
      : {}),
  }),
  component: SpaceRoute,
});

function SpaceRoute() {
  const { spaceId } = Route.useParams();
  const { page, tab } = Route.useSearch();
  return <SpacePage key={spaceId} spaceId={spaceId} page={page ?? null} tab={tab ?? "chats"} />;
}
