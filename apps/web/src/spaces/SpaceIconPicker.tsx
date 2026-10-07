import { DynamicIcon } from "lucide-react/dynamic";

import { cn } from "~/lib/utils";

import { SPACE_COLORS, SPACE_ICONS, type SpaceAppearance, spaceColorHex } from "./spaces";

/** ChatGPT's Space appearance picker: thirty icons over a row of eight colours. */
export function SpaceIconPicker({
  value,
  onChange,
}: {
  readonly value: SpaceAppearance;
  readonly onChange: (next: SpaceAppearance) => void;
}) {
  const hex = spaceColorHex(value.color);
  return (
    <div className="flex w-72 flex-col gap-3">
      <div className="grid grid-cols-6 gap-1" role="group" aria-label="Icon">
        {SPACE_ICONS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-label={option.label}
            aria-pressed={value.icon === option.icon}
            className={cn(
              "flex size-10 items-center justify-center rounded-lg outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              value.icon === option.icon && "bg-accent ring-1 ring-foreground/24",
            )}
            style={hex ? { color: hex } : undefined}
            onClick={() => onChange({ ...value, icon: option.icon })}
          >
            <DynamicIcon name={option.icon} className="size-5" />
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2" role="group" aria-label="Color">
        {SPACE_COLORS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            aria-pressed={value.color === option.value}
            className={cn(
              "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value.color === option.value && "border-foreground/64",
            )}
            onClick={() => onChange({ ...value, color: option.value })}
          >
            <span
              className={cn("size-4 rounded-full", option.hex === null && "bg-foreground")}
              style={option.hex ? { backgroundColor: option.hex } : undefined}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
