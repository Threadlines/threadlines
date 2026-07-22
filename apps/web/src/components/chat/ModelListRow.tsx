import { type ProviderDriverKind, type ProviderInstanceId } from "@threadlines/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getProviderScopedDisplayModelLabel,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useProviderScopedLabel?: boolean;
  useTriggerLabel?: boolean;
  jumpLabel?: string | null;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;
  const modelNameOptions = props.preferShortName ? { preferShortName: true } : undefined;
  const modelLabel = props.useTriggerLabel
    ? props.useProviderScopedLabel
      ? getProviderScopedDisplayModelLabel(props.model, props.driverKind, {
          preferShortName: true,
        })
      : getTriggerDisplayModelLabel(props.model)
    : props.useProviderScopedLabel
      ? getProviderScopedDisplayModelLabel(props.model, props.driverKind, modelNameOptions)
      : getDisplayModelName(props.model, modelNameOptions);

  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      contentClassName="flex w-full min-w-0"
      className={cn(
        "group relative w-full cursor-pointer rounded pl-3 pr-3 transition-colors",
        // Single-line rows keep a compact fixed height; rows with a
        // description or provider footer grow to two lines.
        props.model.description || props.showProvider ? "py-1.5" : "h-8 py-0",
        // Selection is marked by the inline check + primary-tinted name so
        // it stays distinguishable from the grey hover/keyboard highlight
        // (--accent and --muted resolve to the same grey in both themes).
        "hover:bg-muted data-highlighted:bg-muted data-selected:bg-transparent data-selected:text-foreground [&[data-highlighted][data-selected]]:bg-muted",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div
            className="text-xs font-medium leading-snug flex items-center gap-1.5 min-w-0 group-data-selected:text-primary-readable"
            data-model-picker-model-name
          >
            <span className="truncate">{modelLabel}</span>
            {props.model.isDefault === true ? (
              <span className="shrink-0 font-mono text-[9px] font-normal tracking-[0.08em] text-muted-foreground/65 uppercase">
                Default
              </span>
            ) : null}
            {/* Inline selection check (no left gutter — rows keep their
                full width and unselected rows don't carry an empty column). */}
            <CheckIcon
              aria-hidden
              className="hidden size-3.5 shrink-0 text-primary-readable group-data-selected:inline-block"
            />
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            {/* Favorited rows keep the filled star visible in provider tabs;
                non-favorites reveal the action on hover/focus. */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    className={cn(
                      "flex shrink-0 cursor-pointer items-center rounded-sm p-0.5 transition-opacity",
                      "focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                      props.isFavorite
                        ? "opacity-100 text-yellow-500/80 hover:text-yellow-500"
                        : "opacity-0 text-muted-foreground/50 hover:text-foreground group-hover:opacity-100 group-data-highlighted:opacity-100 pointer-coarse:opacity-100",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onToggleFavorite();
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                    type="button"
                    aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
                  >
                    <StarIcon className={cn("size-3.5", props.isFavorite && "fill-current")} />
                  </button>
                }
              />
              <TooltipPopup side="top" align="center">
                {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              </TooltipPopup>
            </Tooltip>
            {props.jumpLabel ? (
              <Kbd className="h-4 min-w-0 shrink-0 rounded-sm px-1.5 text-[10px]">
                {props.jumpLabel}
              </Kbd>
            ) : null}
          </span>
        </div>
        {props.model.description ? (
          <div
            className="mt-0.5 truncate text-[11px] font-normal leading-snug text-muted-foreground/75"
            title={props.model.description}
          >
            {props.model.description}
          </div>
        ) : null}
        {props.showProvider && (
          <div className="flex items-center gap-1 mt-0.5">
            {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
            {props.providerAccentColor ? (
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: props.providerAccentColor }}
                aria-hidden
              />
            ) : null}
            <span className="text-xs font-normal leading-snug text-muted-foreground/70 truncate">
              {providerLabel}
            </span>
          </div>
        )}
      </div>
    </ComboboxItem>
  );
});
