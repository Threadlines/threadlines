// @effect-diagnostics globalTimers:off - The download link's object URL is released on a plain timer.
import type { DeviceSummary, EnvironmentId } from "@threadlines/contracts";
import { captureDeviceScreenshot } from "@threadlines/client-runtime/device";
import {
  CameraIcon,
  ChevronLeftIcon,
  EllipsisIcon,
  HomeIcon,
  Layers2Icon,
  PowerIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { deviceErrorText } from "./deviceState";
import { DeviceStreamView } from "./DeviceStreamView";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import { useDeviceControls } from "./useDeviceControls";
import { useDeviceStream } from "./useDeviceStream";

const DOWNLOAD_URL_LIFETIME_MS = 60_000;

/**
 * One open device: a toolbar of its hardware buttons and actions, the live
 * screen, and the Tools drawer. Mount it keyed by computer and device.
 */
export function DeviceWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly device: DeviceSummary;
  /** The tab is on screen; nothing streams while it is not. */
  readonly visible: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onPowerOff: () => void;
}) {
  const { device, environmentId, visible } = props;
  const ios = device.platform === "ios";
  const { stream, state } = useDeviceStream({
    environmentId,
    platform: device.platform,
    deviceId: device.id,
    active: visible,
  });
  const [toolsOpen, setToolsOpen] = useState(false);
  // Read while on screen, not only with Tools open: rotating Android goes through it too.
  const controls = useDeviceControls({ environmentId, device, visible });
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A capture always finishes, even if the panel hides meanwhile; the user asked for it.
  const capturing = useRef(false);

  const inputReady = state.input.connected;
  const press = (button: "home" | "back" | "recents" | "appSwitcher") =>
    stream.client.pressButton(button);
  const saveScreenshot = () => {
    if (capturing.current) return;
    capturing.current = true;
    setScreenshotPending(true);
    setNotice(null);
    captureDeviceScreenshot(stream.transport, { platform: device.platform, deviceId: device.id })
      .then((image) => {
        const url = URL.createObjectURL(image);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${device.name.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.png`;
        document.body.append(link);
        link.click();
        link.remove();
        // The browser reads the blob after the click returns.
        window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
      })
      .catch((cause: unknown) => setNotice(deviceErrorText(cause)))
      .finally(() => {
        capturing.current = false;
        setScreenshotPending(false);
      });
  };

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col" data-testid="device-workspace">
      <div
        role="toolbar"
        aria-label="Device controls"
        className="flex h-9 shrink-0 items-center gap-0.5 px-1.5"
      >
        <ToolbarButton label="All devices" onClick={props.onBack}>
          <ChevronLeftIcon />
        </ToolbarButton>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-[13px] leading-4 font-medium">{device.name}</p>
          <p className="truncate font-mono text-[11px] leading-3.5 text-muted-foreground">
            {device.version}
          </p>
        </div>
        <ToolbarButton label="Home" disabled={!inputReady} onClick={() => press("home")}>
          <HomeIcon />
        </ToolbarButton>
        {ios ? (
          <ToolbarButton
            label="App switcher"
            disabled={!inputReady}
            onClick={() => press("appSwitcher")}
          >
            <Layers2Icon />
          </ToolbarButton>
        ) : (
          <>
            <ToolbarButton label="Back" disabled={!inputReady} onClick={() => press("back")}>
              <Undo2Icon />
            </ToolbarButton>
            <ToolbarButton label="Recents" disabled={!inputReady} onClick={() => press("recents")}>
              <SquareIcon />
            </ToolbarButton>
          </>
        )}
        {ios ? (
          <ToolbarButton label="Rotate" disabled={!inputReady} onClick={stream.client.rotate}>
            <RotateCwIcon />
          </ToolbarButton>
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Rotate"
                  tooltip="Rotate"
                  disabled={controls.disabled}
                />
              }
            >
              <RotateCwIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {(["portrait", "landscape_left"] as const).map((value) => (
                <MenuItem
                  key={value}
                  onClick={() => void controls.act({ type: "setOrientation", value })}
                >
                  {value === "portrait" ? "Portrait" : "Landscape"}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
        <ToolbarButton
          label={screenshotPending ? "Saving screenshot…" : "Save screenshot"}
          disabled={state.status !== "streaming" || screenshotPending}
          onClick={saveScreenshot}
        >
          <CameraIcon />
        </ToolbarButton>
        <ToolbarButton
          label="Tools"
          pressed={toolsOpen}
          onClick={() => setToolsOpen((open) => !open)}
        >
          <SlidersHorizontalIcon />
        </ToolbarButton>
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label="More" tooltip="More" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={props.onClose}>
              <XIcon />
              Close device
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={props.onPowerOff}>
              <PowerIcon />
              Power off
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {notice || (controls.error && !toolsOpen) ? (
        <p
          role="alert"
          className="px-3 pb-1 text-xs whitespace-pre-line text-destructive-foreground"
        >
          {notice ?? controls.error}
        </p>
      ) : null}
      {state.mode === "stills" ? (
        <p className="px-3 pb-1 text-xs text-muted-foreground">
          Showing still frames. The desktop app, https or the relay gives full video.
        </p>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 p-2">
          <DeviceStreamView
            platform={device.platform}
            deviceName={device.name}
            deviceDescription={device.version}
            stream={stream}
            state={state}
          />
        </div>
        {toolsOpen ? (
          <DeviceToolsPanel
            device={device}
            controls={controls}
            onClose={() => setToolsOpen(false)}
            className={cn(
              // Beside the screen when the panel is wide, floating over it when not.
              "absolute inset-y-0 right-0 z-20 w-full max-w-72 border-l border-border shadow-lg",
              "@[560px]:static @[560px]:w-72 @[560px]:shrink-0 @[560px]:shadow-none",
            )}
          />
        ) : null}
      </div>
    </div>
  );
}

function ToolbarButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={props.label}
      tooltip={props.label}
      aria-pressed={props.pressed}
      data-pressed={props.pressed ? "" : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}
