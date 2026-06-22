import { type ProviderDriverKind, type ProviderInstanceId } from "@threadlines/contracts";
import { memo } from "react";
import { StarIcon } from "lucide-react";
import {
  getDisplayModelName,
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
  useTriggerLabel?: boolean;
  jumpLabel?: string | null;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      contentClassName="flex w-full min-w-0"
      className={cn(
        "group relative w-full cursor-pointer rounded py-2 pl-4 pr-3 transition-colors",
        "data-highlighted:bg-muted data-selected:bg-accent data-selected:text-foreground",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div
            className="text-xs font-medium leading-snug flex items-center gap-2 min-w-0 group-data-selected:text-primary-readable"
            data-model-picker-model-name
          >
            <span className="truncate">
              {props.useTriggerLabel
                ? getTriggerDisplayModelLabel(props.model)
                : getDisplayModelName(
                    props.model,
                    props.preferShortName ? { preferShortName: true } : undefined,
                  )}
            </span>
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
