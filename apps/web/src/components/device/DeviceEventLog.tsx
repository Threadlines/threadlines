import {
  appendDeviceEventLog,
  type DeviceEventLogEntry,
  type DeviceHubTransport,
  subscribeDeviceEventLog,
} from "@threadlines/client-runtime/device";
import { useEffect, useState } from "react";

/** "14:02:07" from an event's ISO time; the raw text when it is not one. */
function clockTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * An iOS Simulator's recent events from serve-sim, newest first. Follows the
 * log while mounted (the Tools drawer is open) and cancels the read when it
 * unmounts. Mount it keyed by device.
 */
export function DeviceEventLog(props: {
  readonly transport: DeviceHubTransport;
  readonly deviceId: string;
}) {
  const { transport, deviceId } = props;
  const [entries, setEntries] = useState<ReadonlyArray<DeviceEventLogEntry> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(
    () =>
      subscribeDeviceEventLog(
        transport,
        deviceId,
        (incoming, reset) =>
          setEntries((current) => appendDeviceEventLog(current ?? [], incoming, reset)),
        setFailed,
      ),
    [deviceId, transport],
  );

  if (entries === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {failed ? "The event log is not answering. Trying again…" : "Reading the event log…"}
      </p>
    );
  }
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No events yet.</p>;
  }
  return (
    <ol
      aria-label="Device events"
      data-testid="device-event-log"
      className="-mx-1 flex max-h-56 flex-col overflow-y-auto"
    >
      {entries.toReversed().map((entry) => (
        <li key={entry.id} className="flex min-w-0 gap-2 rounded-md px-1 py-0.5 text-xs">
          <time
            dateTime={entry.timestamp}
            className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground"
          >
            {clockTime(entry.timestamp)}
          </time>
          <span className="min-w-0 flex-1 leading-4 break-words">
            {entry.kind ? <span className="text-muted-foreground">{entry.kind} </span> : null}
            {entry.summary}
          </span>
        </li>
      ))}
    </ol>
  );
}
