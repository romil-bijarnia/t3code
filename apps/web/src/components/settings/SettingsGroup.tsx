import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/** Shared settings card surface, with optional separators between rows. */
export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
}) {
  return (
    <div
      {...props}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped" ? "overflow-hidden rounded-2xl border border-border" : "space-y-1",
        variant === "grouped" && divided && "[&>*+*]:border-t [&>*+*]:border-border",
        className,
      )}
    />
  );
}
