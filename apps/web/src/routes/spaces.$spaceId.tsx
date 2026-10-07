import { createFileRoute } from "@tanstack/react-router";

import { SpacePage } from "../spaces/SpacePage";

export interface SpaceSearch {
  readonly page?: string;
}

export const Route = createFileRoute("/spaces/$spaceId")({
  validateSearch: (raw: Record<string, unknown>): SpaceSearch =>
    typeof raw.page === "string" && raw.page.trim() ? { page: raw.page } : {},
  component: SpaceRoute,
});

function SpaceRoute() {
  const { spaceId } = Route.useParams();
  const { page } = Route.useSearch();
  return <SpacePage key={spaceId} spaceId={spaceId} page={page ?? null} />;
}
