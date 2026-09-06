/**
 * The composer's dictation control.
 *
 * A split button in the right-hand cluster: the mic records, the narrow
 * chevron opens microphone and hold-to-record options. While recording, the
 * control is replaced in place by a timer pill so nothing else in the row
 * moves. The first use, before the speech model is on the server, opens a
 * setup popover instead of recording.
 *
 * The recording state itself lives in `useDictation`, owned by `ChatComposer`,
 * because a failed clip is reported in the composer's notice dock.
 *
 * @module ComposerDictationControl
 */
import type { DictationModelId, EnvironmentApi, EnvironmentId } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, LoaderCircleIcon, MicIcon, Settings2Icon } from "lucide-react";
import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "~/lib/utils";
import {
  DictationProgressBar,
  DictationProgressLabel,
} from "../../dictation/DictationDownloadProgress";
import {
  DICTATION_MODEL_PRESENTATION,
  findDictationModel,
  selectedModelReady,
} from "../../dictation/dictationModels";
import { useDictationStatus } from "../../dictation/dictationStatusStore";
import type { DictationControl } from "../../dictation/useDictation";
import { useMicrophoneDevices } from "../../dictation/useMicrophoneDevices";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { readEnvironmentApi } from "../../environmentApi";
import { formatDownloadSize } from "../../lib/formatBytes";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const UNSUPPORTED_PLATFORM_REASON = "Dictation isn't available on this server's platform.";
/** A press this short in hold mode is a tap, not speech: drop it and explain. */
const HOLD_TAP_MS = 300;
const HOLD_HINT_MS = 2_500;
/** Chromium lists the system default as its own device under this id. */
const BROWSER_DEFAULT_DEVICE_ID = "default";

const MIC_CLASS_NAME =
  "rounded-s-full rounded-e-none text-muted-foreground/70 hover:text-foreground/80";
const CHEVRON_CLASS_NAME =
  "h-8 w-3.5 rounded-s-none rounded-e-full px-0 text-muted-foreground/70 hover:text-foreground/80 sm:h-7";

export interface ComposerDictationControlProps {
  environmentId: EnvironmentId | null | undefined;
  /** Dictation can't run right now (pending approval, blocking question, offline). */
  disabled: boolean;
  disabledReason: string | null;
  isMobileViewport: boolean;
  dictation: DictationControl;
}

function formatTimer(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const ComposerDictationControl = memo(function ComposerDictationControl(
  props: ComposerDictationControlProps,
) {
  const { environmentId, disabled, disabledReason, isMobileViewport, dictation } = props;
  const status = useDictationStatus(environmentId);
  const { updateSettings } = useUpdateSettings();
  const holdToRecord = useSettings((settings) => settings.dictationHoldToRecord);
  const microphoneDeviceId = useSettings((settings) => settings.dictationMicrophoneDeviceId);
  const selectedModel: DictationModelId = useSettings((settings) => settings.dictationModel);

  const [menuOpen, setMenuOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  // A tap in hold mode records nothing. Rather than a "nothing was heard"
  // error, the control says how the mic works for a moment.
  const [holdHint, setHoldHint] = useState(false);
  const holdHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micRef = useRef<HTMLButtonElement | null>(null);
  const pressStartedAtRef = useRef<number | null>(null);
  const devices = useMicrophoneDevices(menuOpen);
  const hasBrowserDefault = devices.some((device) => device.deviceId === BROWSER_DEFAULT_DEVICE_ID);

  useEffect(
    () => () => {
      if (holdHintTimerRef.current !== null) {
        clearTimeout(holdHintTimerRef.current);
      }
    },
    [],
  );

  const isRecording = dictation.status === "recording";
  const isTranscribing = dictation.status === "transcribing";
  const platformUnsupported = status?.runtime.supported === false;
  const modelReady = selectedModelReady(status, selectedModel);
  const modelStatus = findDictationModel(status, selectedModel);
  const modelPresentation = DICTATION_MODEL_PRESENTATION[selectedModel];
  const runtimeDownloading = status?.runtime.state === "downloading";
  const isDownloading = runtimeDownloading || modelStatus?.state === "downloading";
  // The server keeps the last failure on whichever piece failed; either one
  // belongs in the popover so a retry is not a blind click.
  const downloadError = status?.runtime.error ?? modelStatus?.error ?? null;

  // Until the first status lands there is no way to tell "download needed"
  // from "not connected yet", so the mic waits rather than guessing.
  const statusUnknown = status === undefined;
  const blocked = disabled || platformUnsupported || statusUnknown;
  const blockedReason = platformUnsupported
    ? UNSUPPORTED_PLATFORM_REASON
    : statusUnknown
      ? "Checking dictation on this server…"
      : disabledReason;

  // Derived rather than stored: once the model lands there is nothing left to
  // set up. In hold mode the mic itself is the pill; in click mode a separate
  // pill with a stop square takes its place.
  const setupVisible = setupOpen && !modelReady;
  const showStopSquare = isRecording && !holdToRecord;

  const showHoldHint = () => {
    if (holdHintTimerRef.current !== null) {
      clearTimeout(holdHintTimerRef.current);
    }
    setHoldHint(true);
    holdHintTimerRef.current = setTimeout(() => {
      holdHintTimerRef.current = null;
      setHoldHint(false);
    }, HOLD_HINT_MS);
  };

  const toggleRecording = () => {
    if (blocked || isTranscribing) {
      return;
    }
    if (isRecording) {
      dictation.stop();
      return;
    }
    setHoldHint(false);
    dictation.start();
  };

  const onMicPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // A missing model is the popover trigger's business, not a recording gesture.
    if (!holdToRecord || blocked || isTranscribing || isRecording || !modelReady) {
      return;
    }
    pressStartedAtRef.current = Date.now();
    setHoldHint(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    dictation.start();
  };

  const onMicPointerRelease = () => {
    const pressStartedAt = pressStartedAtRef.current;
    if (pressStartedAt === null) {
      return;
    }
    pressStartedAtRef.current = null;
    if (Date.now() - pressStartedAt < HOLD_TAP_MS) {
      dictation.cancel();
      showHoldHint();
      return;
    }
    dictation.stop();
  };

  const downloadProgress = runtimeDownloading
    ? { done: status?.runtime.bytesDownloaded ?? 0, total: status?.runtime.bytesTotal ?? 0 }
    : { done: modelStatus?.bytesDownloaded ?? 0, total: modelStatus?.bytesTotal ?? 0 };

  const runDictationCommand = (run: (api: EnvironmentApi) => Promise<void>) => {
    if (!environmentId) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }
    void run(api).catch(() => undefined);
  };

  const setupPopup = (
    <PopoverPopup
      side="top"
      align="end"
      className="w-[24.5rem] max-w-[calc(100vw-2rem)]"
      viewportClassName="py-3"
    >
      {isDownloading ? (
        <div className="flex flex-col gap-1.5">
          <p className="font-semibold text-sm">Downloading {modelPresentation.name}</p>
          {runtimeDownloading ? (
            <p className="text-muted-foreground text-xs">Preparing speech engine…</p>
          ) : null}
          <DictationProgressBar
            bytesDownloaded={downloadProgress.done}
            bytesTotal={downloadProgress.total}
            className="mt-1"
          />
          <div className="flex items-center gap-2">
            <DictationProgressLabel
              bytesDownloaded={downloadProgress.done}
              bytesTotal={downloadProgress.total}
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="ms-auto"
              onClick={() =>
                runDictationCommand((api) => api.dictation.cancelDownload({ model: selectedModel }))
              }
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="space-y-1">
            <p className="font-semibold text-sm">Set up dictation</p>
            <p className="text-muted-foreground text-xs leading-snug">
              Speech is turned into text on this computer. Nothing is sent to the internet. Download
              the speech model once to start.
            </p>
            {downloadError ? (
              <p className="text-destructive-foreground text-xs leading-snug">{downloadError}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              onClick={() =>
                runDictationCommand((api) => api.dictation.downloadModel({ model: selectedModel }))
              }
            >
              {`Download ${modelPresentation.name} · ${formatDownloadSize(modelStatus?.bytesTotal ?? 0)}`}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              render={<Link to="/settings/general" hash="dictation" />}
            >
              Choose a model in Settings
            </Button>
          </div>
        </div>
      )}
    </PopoverPopup>
  );

  if (isTranscribing) {
    return (
      <span
        role="status"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-muted-foreground text-xs sm:h-7"
      >
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
        {isMobileViewport ? <span className="sr-only">Transcribing…</span> : "Transcribing…"}
      </span>
    );
  }

  return (
    <span
      className="flex shrink-0 items-center"
      onKeyDown={(event) => {
        if (event.key === "Escape" && isRecording) {
          event.stopPropagation();
          dictation.cancel();
        }
      }}
    >
      {/* Anchored to the mic rather than triggered by it: the mic is already
          the setup popover's trigger, and this only shows after a tap. */}
      <Tooltip
        open={holdHint && !isRecording}
        onOpenChange={(open) => {
          if (!open) {
            setHoldHint(false);
          }
        }}
      >
        <TooltipPopup side="top" anchor={micRef}>
          Hold the mic while you talk, then let go
        </TooltipPopup>
      </Tooltip>
      {blocked ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-full text-muted-foreground/70"
                aria-label="Dictate"
                disabled
              />
            }
          >
            <MicIcon className="size-4" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">{blockedReason ?? "Dictate"}</TooltipPopup>
        </Tooltip>
      ) : showStopSquare ? null : (
        // The mic is the setup popover's trigger so Base UI anchors and
        // dismisses it properly, but the popover only opens while the model is
        // still missing: once it is there the same click records instead.
        <Popover open={setupVisible} onOpenChange={(open) => setSetupOpen(open && !modelReady)}>
          <PopoverTrigger
            render={
              <Button
                ref={micRef}
                type="button"
                variant="ghost"
                // The pill needs a text-style size: the icon size pins width
                // and height together, which is what left the timer spilling
                // out of a circle.
                size={isRecording ? "sm" : "icon-sm"}
                aria-label={isRecording ? "Stop recording" : "Dictate"}
                className={cn(
                  MIC_CLASS_NAME,
                  "touch-none select-none",
                  // Without the chevron beside it the mic stands alone and
                  // keeps a full round shape.
                  isMobileViewport && "rounded-full",
                  isRecording && "rounded-full bg-accent px-2 hover:bg-accent",
                )}
              />
            }
            onPointerDown={onMicPointerDown}
            onPointerUp={onMicPointerRelease}
            onPointerCancel={onMicPointerRelease}
            onLostPointerCapture={onMicPointerRelease}
            onContextMenu={(event) => {
              if (isRecording) {
                event.preventDefault();
              }
            }}
            onClick={(event) => {
              // Pointer presses are already handled above in hold mode; a
              // keyboard activation reports no pointer detail and still toggles.
              if (!modelReady || (holdToRecord && event.detail !== 0)) {
                return;
              }
              toggleRecording();
            }}
          >
            {isRecording ? (
              <>
                <span
                  aria-hidden="true"
                  className="size-[7px] shrink-0 rounded-full bg-destructive"
                />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {formatTimer(dictation.elapsedMs)}
                </span>
              </>
            ) : (
              <MicIcon className="size-4" aria-hidden="true" />
            )}
          </PopoverTrigger>
          {setupPopup}
        </Popover>
      )}

      {showStopSquare ? (
        <span
          role="status"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 ps-2 pe-1 text-destructive-foreground sm:h-7"
        >
          <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-destructive" />
          <span className="font-mono text-[11px]">{formatTimer(dictation.elapsedMs)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Stop recording"
            className="rounded-full text-destructive-foreground hover:text-destructive-foreground"
            onClick={() => dictation.stop()}
          >
            <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-current" />
          </Button>
        </span>
      ) : null}

      {/* Phones have one microphone and keep the hold switch in Settings, so
          the options menu would only cost row width there. */}
      {isRecording || isMobileViewport ? null : (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className={CHEVRON_CLASS_NAME}
                aria-label="Dictation options"
                disabled={blocked}
              />
            }
          >
            <ChevronDownIcon className="size-3" aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" className="w-72 max-w-[calc(100vw-2rem)]">
            <MenuGroup>
              {/* The gear rides in the label's empty right half instead of
                  spending a row and a divider on a "Dictation settings…" item. */}
              <MenuGroupLabel className="flex items-center justify-between pe-1">
                <span>Microphone</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  // Centred between the popup's top edge and the first device
                  // row, not on the label text: the popup pads above the label
                  // but nothing pads below it.
                  className="-mt-1.5 -mb-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Dictation settings"
                  tooltip="Dictation settings"
                  render={<Link to="/settings/general" hash="dictation" />}
                >
                  <Settings2Icon className="size-3.5" aria-hidden="true" />
                </Button>
              </MenuGroupLabel>
              {/* "Follow the system default" is stored as null. Chromium lists
                  that default as a device of its own, so it stands in for the
                  plain "Default" row wherever it exists. */}
              <MenuRadioGroup
                value={microphoneDeviceId ?? (hasBrowserDefault ? BROWSER_DEFAULT_DEVICE_ID : "")}
                onValueChange={(value) =>
                  updateSettings({
                    dictationMicrophoneDeviceId:
                      typeof value === "string" &&
                      value !== "" &&
                      value !== BROWSER_DEFAULT_DEVICE_ID
                        ? value
                        : null,
                  })
                }
              >
                {hasBrowserDefault ? null : <MenuRadioItem value="">Default</MenuRadioItem>}
                {devices.map((device) => (
                  <MenuRadioItem key={device.deviceId} value={device.deviceId} title={device.label}>
                    <span className="min-w-0 flex-1 truncate">{device.label}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem
              variant="switch"
              closeOnClick={false}
              className="min-h-0 items-start py-1.5 sm:min-h-0"
              checked={holdToRecord}
              onCheckedChange={(checked) =>
                updateSettings({ dictationHoldToRecord: Boolean(checked) })
              }
            >
              <span className="flex flex-col gap-0.5 text-start">
                <span>Hold to record</span>
                <span className="text-muted-foreground text-xs leading-snug">
                  {isMobileViewport
                    ? "Off: tap to start, tap again to stop."
                    : "Off: click to start, click again to stop."}
                </span>
              </span>
            </MenuCheckboxItem>
          </MenuPopup>
        </Menu>
      )}
    </span>
  );
});
