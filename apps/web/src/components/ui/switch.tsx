"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "~/lib/utils";

/**
 * `mixed` renders the thumb centred on a muted track for a selection whose
 * targets disagree (the macOS mixed-state convention). It is presentational:
 * the caller still decides what a click sets, usually on for everyone.
 */
function Switch({
  className,
  size = "default",
  mixed = false,
  ...props
}: SwitchPrimitive.Root.Props & { size?: "default" | "sm"; mixed?: boolean }) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5 outline-none transition-[background-color,box-shadow] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-(--codex-accent) data-unchecked:bg-foreground/10 data-disabled:cursor-not-allowed data-disabled:opacity-60 data-[mixed]:bg-foreground/10",
        size === "sm" ? "h-4 w-7" : "h-5 w-8",
        className,
      )}
      data-size={size}
      data-slot="switch"
      data-mixed={mixed ? "" : undefined}
      // Base UI copies every key we pass, even `undefined`, over its own
      // aria-checked. Only pass the attribute when mixed so the real state
      // survives for screen readers.
      {...(mixed ? { "aria-checked": "mixed" as const } : {})}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block shrink-0 rounded-full border border-black/5 bg-white shadow-sm transition-transform duration-150 ease-out data-checked:translate-x-3",
          size === "sm" ? "size-3" : "size-4",
          mixed && "translate-x-1.5 opacity-70 data-checked:translate-x-1.5",
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
