import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { SpaceIcon } from "./SpaceIcon";
import { SpaceIconPicker } from "./SpaceIconPicker";
import {
  DEFAULT_SPACE_COLOR,
  DEFAULT_SPACE_ICON,
  safeFileName,
  type SpaceAppearance,
  spaceFolderName,
  useSpaces,
} from "./spaces";
import { useSpaceActions } from "./useSpaceActions";

/** ChatGPT's "Create a space" dialog: a name with the icon picker in front of it. */
export function NewSpaceDialog({
  environmentId,
  open,
  onOpenChange,
  onCreated,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (spaceId: ProjectId) => void;
}) {
  const spaces = useSpaces();
  const { createSpace } = useSpaceActions();
  const [name, setName] = useState("");
  const [appearance, setAppearance] = useState<SpaceAppearance>({
    icon: DEFAULT_SPACE_ICON,
    color: DEFAULT_SPACE_COLOR,
  });
  const [creating, setCreating] = useState(false);

  const folderName = safeFileName(name);
  const taken = spaces.some(
    (space) => spaceFolderName(space.workspaceRoot).toLowerCase() === folderName.toLowerCase(),
  );
  const canCreate = environmentId !== null && folderName.length > 0 && !taken && !creating;

  const create = async () => {
    if (!canCreate || environmentId === null) return;
    setCreating(true);
    const spaceId = await createSpace({ environmentId, name: name.trim(), appearance });
    setCreating(false);
    if (spaceId === null) return;
    onOpenChange(false);
    onCreated(spaceId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[26rem]">
        <DialogHeader>
          <DialogTitle>Create a space</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <div className="flex h-11 items-center gap-2 rounded-xl border border-input bg-transparent pr-3 pl-1.5 focus-within:border-ring">
              <Popover>
                <PopoverTrigger
                  render={<Button size="icon-sm" variant="ghost" aria-label="Change icon" />}
                >
                  <SpaceIcon appearance={appearance} size="leading" />
                </PopoverTrigger>
                <PopoverPopup align="start">
                  <SpaceIconPicker value={appearance} onChange={setAppearance} />
                </PopoverPopup>
              </Popover>
              <span aria-hidden className="h-6 w-px bg-border" />
              <input
                aria-label="Space name"
                autoFocus
                maxLength={50}
                className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
                placeholder="Name the topic or group"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void create();
                }}
              />
            </div>
            {taken ? (
              <p className="text-sm text-muted-foreground">
                A space with that name already exists.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="lg" disabled={!canCreate} onClick={() => void create()}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
