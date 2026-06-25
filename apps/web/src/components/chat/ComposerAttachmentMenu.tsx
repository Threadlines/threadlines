import { memo } from "react";
import { CameraIcon, ImageUpIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerAttachmentMenuProps {
  /** Desktop bridge can capture screenshots (adds a second action to the menu). */
  canCaptureScreenshot: boolean;
  isCapturingScreenshot: boolean;
  /** Attachments can't be added right now (model can't accept images, pending prompt, etc.). */
  disabled: boolean;
  disabledReason: string | null;
  /** Opens the native file picker. On phones this surfaces the camera / photo library / files. */
  onUploadImage: () => void;
  onCaptureScreenshot: () => void;
}

const TRIGGER_CLASS_NAME = "rounded-full text-muted-foreground/70 hover:text-foreground/80";

/**
 * Adaptive composer "Add" control.
 *
 * - Disabled: a single inert "+" button explaining why (no menu to open).
 * - Upload only (e.g. mobile/web without desktop screenshot capture): the "+"
 *   opens the native file picker directly so phones take a single tap.
 * - Upload + screenshot (desktop): the "+" opens a menu to choose between them.
 */
export const ComposerAttachmentMenu = memo(function ComposerAttachmentMenu(
  props: ComposerAttachmentMenuProps,
) {
  const {
    canCaptureScreenshot,
    isCapturingScreenshot,
    disabled,
    disabledReason,
    onUploadImage,
    onCaptureScreenshot,
  } = props;

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={TRIGGER_CLASS_NAME}
              aria-label="Add attachment"
              disabled
            />
          }
        >
          <PlusIcon className="size-4" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">{disabledReason ?? "Add attachment"}</TooltipPopup>
      </Tooltip>
    );
  }

  if (!canCaptureScreenshot) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={TRIGGER_CLASS_NAME}
              aria-label="Add image"
              onClick={onUploadImage}
            />
          }
        >
          <PlusIcon className="size-4" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">Add image</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={TRIGGER_CLASS_NAME}
            aria-label="Add attachment"
          />
        }
      >
        {isCapturingScreenshot ? (
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <PlusIcon className="size-4" aria-hidden="true" />
        )}
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        <MenuItem onClick={onUploadImage}>
          <ImageUpIcon aria-hidden="true" />
          Upload image
        </MenuItem>
        <MenuItem onClick={onCaptureScreenshot} disabled={isCapturingScreenshot}>
          {isCapturingScreenshot ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <CameraIcon aria-hidden="true" />
          )}
          Capture screenshot
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
