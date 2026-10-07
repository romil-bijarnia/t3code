import { useState } from "react";

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

/** "Rename space" / "Rename page", as in ChatGPT: one field, Save and Cancel. */
export function RenameDialog({
  kind,
  initialValue,
  onClose,
  onSave,
}: {
  readonly kind: "space" | "page";
  readonly initialValue: string;
  readonly onClose: () => void;
  readonly onSave: (value: string) => Promise<unknown> | void;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(trimmed);
    } finally {
      setSaving(false);
    }
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="w-full sm:w-[24rem]">
        <DialogHeader>
          <DialogTitle>{kind === "space" ? "Rename space" : "Rename page"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-muted-foreground">
              {kind === "space" ? "Space name" : "Page title"}
            </span>
            <Input
              autoFocus
              maxLength={kind === "space" ? 50 : 80}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onFocus={(event) => event.target.select()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** "Delete {title}?" with ChatGPT's wording for a space or a page. */
export function DeleteDialog({
  kind,
  title,
  onClose,
  onConfirm,
}: {
  readonly kind: "space" | "page";
  readonly title: string;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="w-full sm:w-[26rem]">
        <DialogHeader>
          <DialogTitle>Delete {title}?</DialogTitle>
          <DialogDescription>
            {kind === "space"
              ? "This space, its pages and its chats will move to Trash. You can restore them from Trash."
              : "This page and its subpages will move to Trash. You can restore them from Trash."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            Delete
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
