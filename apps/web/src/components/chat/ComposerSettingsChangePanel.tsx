import type { OrchestrationSettingsChangeRequest, ScopedThreadRef } from "@threadlines/contracts";
import { type PlaceId, placeById, placeHref } from "@threadlines/shared/appPlaces";
import { memo, useMemo, useState } from "react";

import { isElectron } from "~/env";

import {
  isPrimaryEnvironmentOnThisComputer,
  usePrimaryEnvironmentDescriptor,
} from "~/environments/primary";
import { useEnvironmentProviders } from "~/hooks/useEnvironmentProviders";
import { useSettings } from "~/hooks/useSettings";
import { useThemeChoice } from "~/theme/themeStore";
import { themeChoiceName } from "~/themeLibrary/themeCatalog";
import { describeThisBrowser } from "~/relayDevice";
import { pushAlertsSupport, usePushAlertsStore } from "~/pushAlerts/pushAlerts";
import { useComputerLabel } from "../sidebar/linkedComputers";
import { Button } from "../ui/button";
import { PlaceLink } from "./PlaceLink";
import {
  checkDeviceChanges,
  settingsChangeDeviceLabel,
  settingsChangeLines,
} from "./settingsChangeCard.logic";
import { answerSettingsChange } from "./settingsChangeClaims";

/**
 * An agent asks to change settings (`settings_change`,
 * docs/design/agent-settings-changes.md). Docked above the message box like
 * the child-thread and scheduled-task cards: one line per setting, its name a
 * link to its row, what it is now and what it would be, and where it lands
 * (the thread's computer, or this device). Change makes them; Not now makes
 * none.
 */
export const ComposerSettingsChangePanel = memo(function ComposerSettingsChangePanel(props: {
  threadRef: ScopedThreadRef;
  request: OrchestrationSettingsChangeRequest;
}) {
  const { request, threadRef } = props;
  const [responding, setResponding] = useState(false);
  const settings = useSettings();
  const theme = themeChoiceName(useThemeChoice());
  const computerLabel = useComputerLabel();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const providersOf = useEnvironmentProviders();
  const providers = providersOf(threadRef.environmentId);
  const alertKinds = usePushAlertsStore((state) => state.kinds);
  const alertsQuiet = usePushAlertsStore((state) => state.quietAtComputer);
  const alertsOn = usePushAlertsStore((state) => state.enabled && state.permission === "granted");

  // Device values are this app's, read live; computer ones are what the
  // computer had when the agent asked.
  const lines = useMemo(
    () =>
      settingsChangeLines(
        request,
        (placeId: PlaceId) => {
          const edit = placeById(placeId).edit;
          if (edit === undefined || edit.lands !== "device") return undefined;
          if (!("store" in edit)) return edit.read(settings);
          if (edit.store === "theme") return theme;
          return edit.alert === "quietAtComputer" ? alertsQuiet : alertKinds[edit.alert];
        },
        providers,
      ),
    [alertKinds, alertsQuiet, providers, request, settings, theme],
  );
  const deviceCheck = useMemo(
    () =>
      checkDeviceChanges(request, {
        desktopApp: isElectron,
        alerts: pushAlertsSupport() !== "supported" ? "unsupported" : alertsOn ? "on" : "off",
      }),
    [alertsOn, request],
  );
  const claimed = request.status === "claimed";
  const computerName = computerLabel(threadRef.environmentId, "its computer");

  const respond = async (allow: boolean) => {
    setResponding(true);
    try {
      await answerSettingsChange({
        threadRef,
        requestId: request.requestId,
        allow,
        deviceLabel: settingsChangeDeviceLabel({
          desktopApp: isPrimaryEnvironmentOnThisComputer(),
          thisComputerName: primaryDescriptor?.label ?? null,
          browserLabel: describeThisBrowser().label,
        }),
        deviceEdits: deviceCheck.kind === "ready" ? deviceCheck.edits : [],
        lines,
      });
    } finally {
      setResponding(false);
    }
  };

  const count = request.changes.length;
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4" data-testid="settings-change-panel">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tracking-[0.2em] uppercase">Agent request</span>
          <span className="text-sm font-medium" data-testid="settings-change-panel-heading">
            {count === 1
              ? "The agent wants to change a setting"
              : `The agent wants to change ${count} settings`}
          </span>
        </div>
        <ul className="space-y-1">
          {lines.map((line) => (
            <li
              key={line.place}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
              data-testid="settings-change-panel-line"
              data-lands={line.lands}
            >
              {line.placeId !== null ? (
                <PlaceLink
                  href={placeHref(line.placeId)}
                  linkText={line.name}
                  threadEnvironmentId={threadRef.environmentId}
                  threadRef={threadRef}
                  className="top-0 shrink-0"
                >
                  {line.name}
                </PlaceLink>
              ) : (
                <span className="shrink-0 text-foreground">{line.name}</span>
              )}
              <span className="min-w-0 text-muted-foreground" data-settings-change-value>
                {line.from === null
                  ? `to ${line.to}`
                  : line.from === line.to
                    ? `already ${line.to}`
                    : `${line.from} → ${line.to}`}
              </span>
              <span
                className="ms-auto max-w-48 shrink-0 truncate font-mono text-[11px] text-muted-foreground"
                data-settings-change-lands
              >
                {line.lands === "computer" ? computerName : "this device"}
              </span>
            </li>
          ))}
        </ul>
        {deviceCheck.kind === "update" ? (
          <p className="text-xs text-muted-foreground" data-testid="settings-change-panel-update">
            Update Threadlines on this device to make these changes.
          </p>
        ) : null}
        {deviceCheck.kind === "elsewhere" ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="settings-change-panel-elsewhere"
          >
            {deviceCheck.note}
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={responding || claimed}
          onClick={() => void respond(false)}
        >
          Not now
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={responding || claimed || deviceCheck.kind !== "ready"}
          onClick={() => void respond(true)}
        >
          {claimed ? "Changing…" : "Change"}
        </Button>
      </div>
    </div>
  );
});
