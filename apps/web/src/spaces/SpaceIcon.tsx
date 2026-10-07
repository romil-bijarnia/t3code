import { DynamicIcon } from "lucide-react/dynamic";

import { cn } from "~/lib/utils";

import { type SpaceAppearance, spaceColorHex } from "./spaces";

/**
 * A Space's glyph the way ChatGPT draws it: a bare coloured 16px icon in
 * lists, a 20px rounded chip, or the big tinted square above a page title.
 */
export function SpaceIcon({
  appearance,
  size = "leading",
  className,
}: {
  readonly appearance: SpaceAppearance;
  readonly size?: "leading" | "chip" | "large";
  readonly className?: string;
}) {
  const hex = spaceColorHex(appearance.color);
  const style = hex ? { color: hex } : undefined;
  if (size === "leading") {
    return (
      <span
        aria-hidden
        className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
        style={style}
      >
        <DynamicIcon name={appearance.icon} className="size-4" style={style} />
      </span>
    );
  }
  if (size === "chip") {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-md",
          hex ? "bg-current/15" : "bg-foreground/5",
          className,
        )}
        style={style}
      >
        <DynamicIcon name={appearance.icon} className="size-3.5" style={style} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-16 shrink-0 items-center justify-center rounded-2xl",
        hex ? "bg-current/10" : "bg-foreground/5",
        className,
      )}
      style={style}
    >
      <DynamicIcon name={appearance.icon} className="size-8" style={style} />
    </span>
  );
}
