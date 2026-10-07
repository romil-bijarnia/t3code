import { createFileRoute } from "@tanstack/react-router";

import { SpaceTrashPage } from "../spaces/SpaceTrashPage";

export const Route = createFileRoute("/spaces/trash")({
  component: SpaceTrashPage,
});
