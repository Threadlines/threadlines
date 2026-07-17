import { memo } from "react";
import { CameraIcon, FileUpIcon, ImageUpIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerAttachmentMenuProps {
  /** Desktop bridge can capture screenshots (adds a third action to the menu). */
  canCaptureScreenshot: boolean;
  isCapturingScreenshot: boolean;
  /** Phones retain their source-specific native photo and document pickers. */
  isMobileViewport: boolean;
  /** Attachments can't be added right now (pending prompt, approval state, etc.). */
  disabled: boolean;
  disabledReason: string | null;
  /** Opens the native picker filtered to images. On phones this surfaces the camera / photo library. */
  onAddImage: () => void;
  /** Opens the native picker for every attachment type (on phones this is the document picker). */
  onAttachFiles: () => void;
  onCaptureScreenshot: () => void;
}

const TRIGGER_CLASS_NAME = "rounded-full text-muted-foreground/70 hover:text-foreground/80";

/**
 * Composer "Add" control.
 *
 * - Disabled: a single inert "+" button explaining why (no menu to open).
 * - Otherwise: the "+" opens a unified attachment picker on desktop. Phones
 *   retain separate image and file actions so the native camera/photo-library
 *   flow remains available.
 */
export const ComposerAttachmentMenu = memo(function ComposerAttachmentMenu(
  props: ComposerAttachmentMenuProps,
) {
  const {
    canCaptureScreenshot,
    isCapturingScreenshot,
    isMobileViewport,
    disabled,
    disabledReason,
    onAddImage,
    onAttachFiles,
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
        {isMobileViewport ? (
          <>
            <MenuItem onClick={onAddImage}>
              <ImageUpIcon aria-hidden="true" />
              Add image
            </MenuItem>
            <MenuItem onClick={onAttachFiles}>
              <FileUpIcon aria-hidden="true" />
              Add file
            </MenuItem>
          </>
        ) : (
          <MenuItem onClick={onAttachFiles}>
            <FileUpIcon aria-hidden="true" />
            Attach files
          </MenuItem>
        )}
        {canCaptureScreenshot && (
          <MenuItem onClick={onCaptureScreenshot} disabled={isCapturingScreenshot}>
            {isCapturingScreenshot ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <CameraIcon aria-hidden="true" />
            )}
            Capture screenshot
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
});
