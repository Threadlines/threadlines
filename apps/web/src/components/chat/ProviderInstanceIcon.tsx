import { type CSSProperties, memo } from "react";
import { type ProviderDriverKind } from "@threadlines/contracts";

import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import { cn } from "~/lib/utils";

function labelWords(label: string): string[] {
  return label
    .replace(/[_-]+/g, " ")
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
}

export function providerInstanceInitials(label: string): string {
  const words = labelWords(label);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The letters on an instance's badge. An extra account is named
 * "Claude · Work" and its logo already says Claude, so the badge spells the
 * account: "W" ("Side Project" gives "SP").
 */
export function providerInstanceBadgeLetters(label: string): string {
  const separator = label.lastIndexOf(" · ");
  const words = labelWords(separator === -1 ? label : label.slice(separator + 3));
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;

  return (
    <span
      className={cn(
        "relative isolate inline-flex shrink-0 items-center justify-center",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-[10px] font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
            props.statusDotClassName,
          )}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-background px-0.5 text-[8px] font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-[var(--provider-accent)] text-white"
              : "bg-muted text-muted-foreground",
            props.badgeClassName,
          )}
          aria-hidden
        >
          {providerInstanceBadgeLetters(props.displayName)}
        </span>
      ) : null}
    </span>
  );
});
