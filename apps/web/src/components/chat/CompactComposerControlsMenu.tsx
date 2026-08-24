import type { ProviderInteractionMode, RuntimeMode } from "@threadlines/contracts";
import { memo, type ReactNode, useState } from "react";
import { BookmarkIcon, EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { interactionModeOptions } from "../../interactionModeOptions";
import type { RuntimeModeOption } from "../../runtimeModeOptions";
import {
  ComposerStashDeleteConfirmation,
  ComposerStashMenuItems,
  type ComposerStashControlProps,
  useComposerStashDelete,
} from "./ComposerStashControl";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  stashControlProps: ComposerStashControlProps;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const stashDelete = useComposerStashDelete(props.stashControlProps.onDelete);

  return (
    <>
      <Menu
        open={isMenuOpen || props.stashControlProps.open}
        onOpenChange={(open) => {
          if (!open && stashDelete.deleteConfirmOpen) return;
          setIsMenuOpen(open);
          if (!open && props.stashControlProps.open) {
            props.stashControlProps.onOpenChange(false);
          }
        }}
      >
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
              aria-label="More composer controls"
            />
          }
        >
          <EllipsisIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuSub
            open={props.stashControlProps.open}
            onOpenChange={props.stashControlProps.onOpenChange}
          >
            <MenuSubTrigger>
              <BookmarkIcon aria-hidden="true" />
              Stashed prompts
              {props.stashControlProps.entries.length > 0 ? (
                <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                  {props.stashControlProps.entries.length}
                </span>
              ) : null}
            </MenuSubTrigger>
            <MenuSubPopup className="w-96 max-w-[min(24rem,calc(100vw-2rem))]">
              <ComposerStashMenuItems
                {...props.stashControlProps}
                onDelete={stashDelete.requestDelete}
              />
            </MenuSubPopup>
          </MenuSub>
          <MenuDivider />
          {props.traitsMenuContent ? (
            <>
              {props.traitsMenuContent}
              <MenuDivider />
            </>
          ) : null}
          {props.showInteractionModeToggle ? (
            <>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
              <MenuRadioGroup
                value={props.interactionMode}
                onValueChange={(value) => {
                  if (!value || value === props.interactionMode) return;
                  props.onInteractionModeChange(value as ProviderInteractionMode);
                }}
              >
                {interactionModeOptions.map((option) => {
                  const OptionIcon = option.icon;
                  return (
                    <MenuRadioItem key={option.mode} value={option.mode} title={option.description}>
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <OptionIcon
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate">{option.label}</span>
                      </span>
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
              <MenuDivider />
            </>
          ) : null}
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!value || value === props.runtimeMode) return;
              props.onRuntimeModeChange(value as RuntimeMode);
            }}
          >
            {props.runtimeModeOptions.map((option) => {
              const OptionIcon = option.icon;
              return (
                <MenuRadioItem
                  key={option.mode}
                  value={option.mode}
                  disabled={option.disabled === true}
                  title={
                    option.disabled && option.disabledReason
                      ? option.disabledReason
                      : option.description
                  }
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <OptionIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{option.label}</span>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <ComposerStashDeleteConfirmation
        pendingDelete={stashDelete.pendingDelete}
        open={stashDelete.deleteConfirmOpen}
        onOpenChange={stashDelete.setDeleteConfirmOpen}
        onConfirm={stashDelete.confirmPendingDelete}
      />
    </>
  );
});
