import { memo, type PointerEventHandler } from "react";
import type { RuntimeMode } from "@threadlines/contracts";
import { ChevronDownIcon, CornerDownRightIcon, SquareIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import type { RuntimeModeOption } from "../../runtimeModeOptions";

interface ComposerPrimaryActionsProps {
  compact: boolean;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

/** Shared by the normal toolbar and the approval toolbar. */
export const ComposerStopButton = memo(function ComposerStopButton({
  onInterrupt,
  preserveComposerFocusOnPointerDown = false,
}: {
  onInterrupt: () => void;
  preserveComposerFocusOnPointerDown?: boolean;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="destructive"
      className="rounded-full before:hidden"
      onPointerDown={preserveComposerFocusOnPointerDown ? preventPointerFocus : undefined}
      onClick={onInterrupt}
      aria-label="Stop generation"
      tooltip="Stop"
    >
      <SquareIcon className="size-2.5 fill-current" strokeWidth={0} />
    </Button>
  );
});

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  isRunning,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  runtimeMode,
  runtimeModeOptions,
  onRuntimeModeChange,
  onInterrupt,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;

  if (isRunning) {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        {hasSendableContent ? (
          <Button
            type="submit"
            size="icon"
            className="rounded-full"
            {...pointerFocusProps}
            disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
            aria-label="Steer active turn"
            tooltip="Steer"
          >
            <CornerDownRightIcon className="size-3.5" />
          </Button>
        ) : (
          <ComposerStopButton
            onInterrupt={onInterrupt}
            preserveComposerFocusOnPointerDown={preserveComposerFocusOnPointerDown}
          />
        )}
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
            {runtimeModeOptions.length > 1 ? (
              <>
                <MenuSeparator />
                <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                  Implement using
                </div>
                <MenuRadioGroup
                  value={runtimeMode}
                  onValueChange={(value) => {
                    if (!value || value === runtimeMode) return;
                    onRuntimeModeChange(value as RuntimeMode);
                  }}
                >
                  {runtimeModeOptions.map((option) => (
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
                      {option.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return (
    <button
      type="submit"
      className="flex h-9 w-9 enabled:cursor-pointer items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
      {...pointerFocusProps}
      disabled={isSendBusy || isConnecting || isEnvironmentUnavailable || !hasSendableContent}
      aria-label={
        isEnvironmentUnavailable
          ? "Environment disconnected"
          : isConnecting
            ? "Connecting"
            : isPreparingWorktree
              ? "Preparing worktree"
              : isSendBusy
                ? "Sending"
                : "Send message"
      }
    >
      {isConnecting || isSendBusy ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="animate-spin"
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="20 12"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
});
