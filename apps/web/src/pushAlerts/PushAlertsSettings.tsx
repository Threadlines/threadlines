/**
 * Settings › General › Alerts: this device's phone alerts (pushAlerts.ts).
 * One switch turns them on, three choose which ones, and each paired computer
 * says whether it sends them, with a test alert to prove it.
 */
import type { EnvironmentId, PushAlertKinds } from "@threadlines/contracts";
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

const KIND_ROWS: ReadonlyArray<{
  readonly kind: keyof PushAlertKinds;
  readonly title: string;
  readonly description: string;
}> = [
  {
    kind: "needs_you",
    title: "Needs you",
    description: "An approval, a question or a plan to review.",
  },
  { kind: "finished", title: "Finished", description: "An agent finished its work." },
  {
    kind: "failed",
    title: "Failed",
    description: "A turn stopped with an error, or couldn't start.",
  },
];

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

export function PushAlertsSettingsSection() {
  const support = pushAlertsSupport();
  const enabled = usePushAlertsStore((state) => state.enabled);
  const kinds = usePushAlertsStore((state) => state.kinds);
  const permission = usePushAlertsStore((state) => state.permission);
  const busy = usePushAlertsStore((state) => state.busy);
  const error = usePushAlertsStore((state) => state.error);
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const computers = useMemo(
    () => Object.values(savedById).filter((record) => relayLinkOf(record) !== null),
    [savedById],
  );

  if (support === "unsupported" || computers.length === 0) return null;
  if (support === "needs-home-screen") {
    return (
      <SettingsSection place="general.alerts">
        <SettingsRow
          place="general.alertsOnThisDevice"
          description="Add Threadlines to your Home Screen from the Share menu, then turn alerts on in the app there."
        />
      </SettingsSection>
    );
  }

  const on = enabled && permission === "granted";
  return (
    <SettingsSection place="general.alerts">
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
      {on
        ? KIND_ROWS.map((row) => (
            <SettingsRow
              key={row.kind}
              title={row.title}
              description={row.description}
              control={
                <Switch
                  checked={kinds[row.kind]}
                  disabled={busy}
                  onCheckedChange={(checked) => {
                    void setPushAlertKind(row.kind, Boolean(checked));
                  }}
                  aria-label={`${row.title} alerts`}
                />
              }
            />
          ))
        : null}
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
