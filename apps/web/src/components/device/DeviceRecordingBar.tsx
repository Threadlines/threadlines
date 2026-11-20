// @effect-diagnostics globalTimers:off - The elapsed clock ticks once a second on a plain timer.
import { CircleIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { DEVICE_RECORDING_MAX_MS } from "./deviceRecorder";
import { formatRecordingDuration } from "./deviceRecording.logic";
import type { DeviceRecording } from "./useDeviceRecording";

/** The toolbar's record button: starts a recording, or stops one and adds it to the draft. */
export function DeviceRecordButton(props: {
  readonly recording: DeviceRecording;
  readonly disabled: boolean;
}) {
  const { state } = props.recording;
  const recording = state.status === "recording";
  const label = recording ? "Stop and add to draft" : "Record a flow";
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      tooltip={label}
      aria-pressed={recording}
      data-pressed={recording ? "" : undefined}
      data-testid="device-record"
      disabled={state.status === "saving" || (!recording && props.disabled)}
      onClick={recording ? props.recording.stop : props.recording.start}
    >
      {recording ? (
        <SquareIcon className="fill-destructive text-destructive" />
      ) : (
        <CircleIcon className="text-destructive" />
      )}
    </Button>
  );
}

/** The line under the toolbar while a recording runs or is being added to the draft. */
export function DeviceRecordingStatus(props: { readonly recording: DeviceRecording }) {
  const { state } = props.recording;
  const startedAt = state.status === "recording" ? state.startedAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (state.status === "idle") return null;
  if (state.status === "saving") {
    return (
      <p
        role="status"
        className="flex h-7 shrink-0 items-center gap-1.5 px-3 text-xs text-muted-foreground"
      >
        <Spinner className="size-3.5" /> Adding the recording to the draft…
      </p>
    );
  }
  return (
    <div
      role="status"
      aria-label="Recording"
      data-testid="device-recording-status"
      className="flex h-7 shrink-0 items-center gap-2 pr-1.5 pl-3 text-xs"
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
      <span className="font-mono text-[11px] tabular-nums">
        {formatRecordingDuration(now - state.startedAt)}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        Recording, up to {formatRecordingDuration(DEVICE_RECORDING_MAX_MS)}
      </span>
      <Button size="xs" variant="ghost" onClick={props.recording.discard}>
        Discard
      </Button>
      <Button size="xs" variant="outline" onClick={props.recording.stop}>
        Stop
      </Button>
    </div>
  );
}
