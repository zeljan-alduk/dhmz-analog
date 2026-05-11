"use client";

import { cn } from "@/lib/utils";

export function ModifiedChip({
  active,
  versionCount,
  onClick,
}: {
  active: boolean;
  versionCount: number;
  onClick: () => void;
}) {
  // Always render so the user has a way into version history. Style changes
  // when an active customization is in play.
  const label = active
    ? "Modified"
    : versionCount > 0
    ? `${versionCount} saved`
    : "Theme";
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        active
          ? "Customization is active — click to manage / revert"
          : "Customizations: save / share / load"
      }
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
        active
          ? "bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100"
          : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
      )}
    >
      <span
        className={cn(
          "inline-block w-1.5 h-1.5 rounded-full",
          active ? "bg-amber-500" : "bg-neutral-400"
        )}
      />
      {label}
    </button>
  );
}
