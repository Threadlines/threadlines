import { ChevronDownIcon, PictureInPicture2Icon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { DEVICE_CHIP_NAME_MAX_CHARS } from "./deviceViewStore";

export interface DeviceChip {
  readonly deviceId: string;
  readonly name: string;
  /** The device's own name, shown when a chip was renamed. */
  readonly deviceName: string;
  readonly floating: boolean;
}

/**
 * The thread's open devices as a row of chips at the top of the Device tab
 * (docs/design/devices.md, "Several devices open at once"). A press shows
 * one; double-click or the chip's menu renames it; the menu also closes it;
 * "+" shows the picker. Plain until hover, the shown chip filled.
 */
export function DeviceChips(props: {
  readonly chips: ReadonlyArray<DeviceChip>;
  /** The chip on screen, or null while the picker shows. */
  readonly selectedId: string | null;
  readonly onSelect: (deviceId: string | null) => void;
  readonly onRename: (deviceId: string, name: string) => void;
  readonly onClose: (deviceId: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  // Rename from a menu: the menu must not take focus back from the new field.
  const renameFromMenu = useRef(false);
  return (
    <div
      role="tablist"
      aria-label="Open devices"
      className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto px-1.5 [scrollbar-width:none]"
    >
      {props.chips.map((chip) => {
        const selected = chip.deviceId === props.selectedId;
        if (renaming === chip.deviceId) {
          return (
            <RenameField
              key={chip.deviceId}
              chip={chip}
              onDone={(name) => {
                setRenaming(null);
                if (name !== null) props.onRename(chip.deviceId, name);
              }}
            />
          );
        }
        return (
          <div
            key={chip.deviceId}
            data-device-chip={chip.deviceId}
            className={cn(
              "group/chip flex h-6 max-w-44 shrink-0 items-center rounded-md text-xs",
              selected
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              title={chip.name === chip.deviceName ? undefined : chip.deviceName}
              className="flex h-full min-w-0 items-center gap-1 rounded-md pl-2 focus-ring"
              onClick={() => props.onSelect(chip.deviceId)}
              onDoubleClick={() => setRenaming(chip.deviceId)}
            >
              {chip.floating ? (
                <PictureInPicture2Icon
                  aria-label="Floating"
                  className="size-3 shrink-0 text-muted-foreground"
                />
              ) : null}
              <span className="truncate">{chip.name}</span>
            </button>
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${chip.name} menu`}
                    className={cn(
                      "flex h-full w-5 shrink-0 items-center justify-center rounded-md focus-ring",
                      // Always there on the shown chip and on touch; on hover elsewhere.
                      !selected && "can-hover:opacity-0 can-hover:group-hover/chip:opacity-100",
                    )}
                  />
                }
              >
                <ChevronDownIcon aria-hidden="true" className="size-3" />
              </MenuTrigger>
              <MenuPopup
                align="start"
                finalFocus={() => {
                  const keepFocus = renameFromMenu.current;
                  renameFromMenu.current = false;
                  return !keepFocus;
                }}
              >
                <MenuItem
                  onClick={() => {
                    renameFromMenu.current = true;
                    setRenaming(chip.deviceId);
                  }}
                >
                  Rename…
                </MenuItem>
                <MenuItem onClick={() => props.onClose(chip.deviceId)}>Close device</MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        );
      })}
      <Button
        size="icon-xs"
        variant="ghost"
        role="tab"
        aria-selected={props.selectedId === null}
        aria-label="Open another device"
        tooltip="Open another device"
        className={cn(props.selectedId === null && "bg-accent text-foreground")}
        onClick={() => props.onSelect(null)}
      >
        <PlusIcon />
      </Button>
    </div>
  );
}

function RenameField(props: {
  readonly chip: DeviceChip;
  readonly onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(props.chip.name);
  const [done, setDone] = useState(false);
  const finish = (name: string | null) => {
    if (done) return;
    setDone(true);
    props.onDone(name);
  };
  return (
    <input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field appears because the user asked to rename
      autoFocus
      aria-label={`Rename ${props.chip.deviceName}`}
      placeholder={props.chip.deviceName}
      value={value}
      maxLength={DEVICE_CHIP_NAME_MAX_CHARS}
      className="h-6 w-36 shrink-0 rounded-md bg-background px-2 text-xs text-foreground ring-1 ring-ring outline-none"
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}
