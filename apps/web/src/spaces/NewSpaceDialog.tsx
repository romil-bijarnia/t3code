import type { EnvironmentId, ProjectIconColor, ProjectId } from "@t3tools/contracts";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { PROJECT_ICON_COLORS, projectIconColorClassName } from "../projectIconOptions";
import { safeFileName, useSpaces } from "./spaces";
import { useSpaceActions } from "./useSpaceActions";

const SPACE_ICONS: ReadonlyArray<IconName> = [
  "sparkles",
  "book-open",
  "graduation-cap",
  "briefcase",
  "code",
  "pen-line",
  "lightbulb",
  "heart",
  "globe",
  "flask-conical",
  "music",
  "wallet",
];

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
  const [icon, setIcon] = useState<IconName>("sparkles");
  const [color, setColor] = useState<ProjectIconColor>("blue");
  const [creating, setCreating] = useState(false);

  const folderName = safeFileName(name);
  const taken = spaces.some(
    (space) =>
      space.workspaceRoot.split(/[\\/]/).at(-1)?.toLowerCase() === folderName.toLowerCase(),
  );
  const canCreate = environmentId !== null && folderName.length > 0 && !taken && !creating;

  const create = async () => {
    if (!canCreate || environmentId === null) return;
    setCreating(true);
    const spaceId = await createSpace({
      environmentId,
      name: name.trim(),
      icon: { kind: "lucide", name: icon, color },
    });
    setCreating(false);
    if (spaceId === null) return;
    onOpenChange(false);
    onCreated(spaceId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[28rem]">
        <DialogHeader>
          <DialogTitle>New Space</DialogTitle>
          <DialogDescription>
            A Space keeps its own instructions, pages, files and chats together.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-5">
            <Input
              aria-label="Space name"
              autoFocus
              placeholder="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void create();
              }}
            />
            {taken ? (
              <p className="-mt-3 text-sm text-muted-foreground">A Space with that name exists.</p>
            ) : null}
            <div className="grid grid-cols-6 gap-1.5" role="group" aria-label="Icon">
              {SPACE_ICONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={option}
                  aria-pressed={icon === option}
                  className={cn(
                    "flex h-10 items-center justify-center rounded-lg border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    icon === option && "border-foreground/24 bg-accent",
                  )}
                  onClick={() => setIcon(option)}
                >
                  <DynamicIcon
                    name={option}
                    className={cn("size-5", projectIconColorClassName(color))}
                  />
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Color">
              {PROJECT_ICON_COLORS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={color === option.value}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    color === option.value && "border-foreground/64",
                  )}
                  onClick={() => setColor(option.value)}
                >
                  <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                </button>
              ))}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canCreate} onClick={() => void create()}>
            {creating ? "Creating..." : "Create Space"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
