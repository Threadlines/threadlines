/**
 * Settings › General › Alerts: this device's phone alerts (pushAlerts.ts).
 * One switch turns them on, three choose which ones, and each paired computer
 * says whether it sends them, with a test alert to prove it.
 */
import type { EnvironmentId, PushAlertKinds } from "@threadlines/contracts";
import { placeById, type SettingsPlaceId } from "@threadlines/shared/appPlaces";
import { useMemo, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import {
  type ComputerAlertStatus,
  disablePushAlerts,
  enablePushAlerts,
  pushAlertsSupport,
  relayLinkOf,
  sendTestPushAlert,
  setPushAlertKind,
  usePushAlertsStore,
} from "./pushAlerts";

/** The kinds of alert, in the order the section lists them, each one a place. */
const KIND_ROWS = [
  { kind: "needs_you", place: "general.alertNeedsYou" },
  { kind: "finished", place: "general.alertFinished" },
  { kind: "failed", place: "general.alertFailed" },
] as const satisfies ReadonlyArray<{
  readonly kind: keyof PushAlertKinds;
  readonly place: SettingsPlaceId;
}>;

function describeStatus(status: ComputerAlertStatus | undefined): string {
  switch (status?.state) {
    case "on":
      return "Sends alerts to this device.";
    case "older":
      return "Needs a newer Threadlines to send alerts.";
    case "not-paired":
      return "Added by address, so it can't send alerts. Connect it with a code to get them.";
    case "failed":
      return status.detail;
    case "connecting":
    case undefined:
      return "Turns on when it's connected.";
  }
}

function ComputerRow({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const status = usePushAlertsStore((state) => state.statusByEnvironmentId[environmentId]);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  return (
    <SettingsRow
      title={label}
      description={describeStatus(status)}
      status={testResult}
      control={
        status?.state === "on" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              setTestResult(await sendTestPushAlert(environmentId));
              setTesting(false);
            }}
          >
            {testing ? "Sending…" : "Send a test"}
          </Button>
        ) : null
      }
    />
  );
}

/** Whether alerts can show on this device at all: support, and a computer to hear from. */
function useAlertComputers() {
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  return useMemo(
    () => Object.values(savedById).filter((record) => relayLinkOf(record) !== null),
    [savedById],
  );
}

export function PushAlertsSettingsSection() {
  const support = pushAlertsSupport();
  const enabled = usePushAlertsStore((state) => state.enabled);
  const permission = usePushAlertsStore((state) => state.permission);
  const computers = useAlertComputers();

  if (support === "unsupported" || computers.length === 0) return null;
  const on = support === "supported" && enabled && permission === "granted";
  return (
    <SettingsSection place="general.alerts">
      <AlertsOnThisDeviceRow />
      {on ? KIND_ROWS.map((row) => <AlertKindRow key={row.kind} kind={row.kind} />) : null}
      {on
        ? computers.map((record) => (
            <ComputerRow
              key={record.environmentId}
              environmentId={record.environmentId}
              label={record.label}
            />
          ))
        : null}
    </SettingsSection>
  );
}

/** The switch for alerts on this device (or how to get them, on an iPhone's Safari). */
export function AlertsOnThisDeviceRow() {
  const support = pushAlertsSupport();
  const enabled = usePushAlertsStore((state) => state.enabled);
  const permission = usePushAlertsStore((state) => state.permission);
  const busy = usePushAlertsStore((state) => state.busy);
  const error = usePushAlertsStore((state) => state.error);

  if (support === "needs-home-screen") {
    return (
      <SettingsRow
        place="general.alertsOnThisDevice"
        description="Add Threadlines to your Home Screen from the Share menu, then turn alerts on in the app there."
      />
    );
  }
  const on = enabled && permission === "granted";
  return (
    <SettingsRow
      place="general.alertsOnThisDevice"
      description={
        permission === "denied"
          ? "Alerts are blocked for this app. Allow them in this device's settings."
          : "An alert when an agent needs you or finishes, even with Threadlines closed. A thread you have open stays quiet."
      }
      status={error}
      control={
        <Switch
          checked={on}
          disabled={busy || permission === "denied"}
          onCheckedChange={(checked) => {
            void (checked ? enablePushAlerts() : disablePushAlerts());
          }}
          aria-label="Alerts on this device"
        />
      }
    />
  );
}

/** One kind of alert (needs you, finished, failed), shown while alerts are on. */
export function AlertKindRow({ kind }: { readonly kind: keyof PushAlertKinds }) {
  const enabled = usePushAlertsStore((state) => state.kinds[kind]);
  const busy = usePushAlertsStore((state) => state.busy);
  const place = KIND_ROWS.find((row) => row.kind === kind)!.place;
  return (
    <SettingsRow
      place={place}
      control={
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={(checked) => {
            void setPushAlertKind(kind, Boolean(checked));
          }}
          aria-label={`${placeById(place).title} alerts`}
        />
      }
    />
  );
}
