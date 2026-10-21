import { type CSSProperties, memo, type ReactNode, useMemo } from "react";
import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { BotIcon } from "lucide-react";

import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useServerProviders } from "../../rpc/serverState";
import {
  PROVIDER_ICON_BY_PROVIDER,
  providerIconMaskImage,
  resolveProviderGlyph,
} from "./providerIconUtils";
import { cn } from "~/lib/utils";

function labelWords(label: string): string[] {
  return label
    .replace(/[_-]+/g, " ")
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
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

/**
 * Every provider snapshot the app holds: this computer's first, then each
 * connected computer's, so a thread that lives on another computer still
 * finds its agent's icon.
 */
function useKnownServerProviders(): ReadonlyArray<ServerProvider> {
  const local = useServerProviders();
  const savedEnvironments = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useMemo(() => {
    const remote = Object.values(savedEnvironments).flatMap(
      (environment) => environment.serverConfig?.providers ?? [],
    );
    return remote.length === 0 ? local : [...local, ...remote];
  }, [local, savedEnvironments]);
}

/**
 * A provider's mark, sized and coloured by `className` like any icon. Pass the
 * `instanceId` wherever one is known: an instance with an icon of its own (a
 * community agent) is drawn with it. `driverKind` alone is enough for a
 * built-in provider, and is all there is where no instance exists yet (pass
 * a null `instanceId` there).
 *
 * A registry icon is third-party SVG. It is drawn as a CSS mask over the text
 * colour, the way the built-in glyphs take theirs, and never inserted as
 * markup.
 */
export const ProviderGlyph = memo(function ProviderGlyph(props: {
  instanceId: ProviderInstanceId | null | undefined;
  /** A driver kind, or a raw driver label off the wire. */
  driverKind: string | null | undefined;
  /**
   * A registry icon to draw when there is no instance to read it from: an
   * agent in the community list that isn't installed yet.
   */
  iconSvg?: string | null | undefined;
  className?: string | undefined;
  /** Drawn instead of the generic glyph when the provider has no mark of its own. */
  fallback?: ReactNode;
}) {
  const providers = useKnownServerProviders();
  const glyph = useMemo(
    () =>
      resolveProviderGlyph({
        instanceId: props.instanceId,
        driver: props.driverKind,
        providers,
      }),
    [props.driverKind, props.instanceId, providers],
  );
  const svg = glyph.kind === "svg" ? glyph.svg : (props.iconSvg ?? null);
  const maskImage = useMemo(() => providerIconMaskImage(svg), [svg]);

  if (maskImage !== null) {
    return (
      <span
        aria-hidden="true"
        // `block` is what the base stylesheet gives every <svg>, so the mask
        // sits in a row exactly where a built-in glyph would.
        className={cn("block bg-current mask-contain mask-center mask-no-repeat", props.className)}
        style={{ WebkitMaskImage: maskImage, maskImage }}
      />
    );
  }
  const Icon = glyph.kind === "driver" ? PROVIDER_ICON_BY_PROVIDER[glyph.driver] : undefined;
  if (Icon) {
    return <Icon className={props.className} aria-hidden="true" />;
  }
  if (props.fallback !== undefined) {
    return props.fallback;
  }
  return <BotIcon className={props.className} aria-hidden="true" />;
});

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  /** Null only where the instance does not exist yet (a new account's preview). */
  instanceId: ProviderInstanceId | null;
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
}) {
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
      <ProviderGlyph
        instanceId={props.instanceId}
        driverKind={props.driverKind}
        className={cn("size-5 shrink-0", props.iconClassName)}
      />
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
