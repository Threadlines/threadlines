import type {
  DesktopBackgroundOptions,
  DesktopBackgroundOptionsPatch,
} from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/**
 * The desktop app's background running for scheduled tasks (Settings ›
 * General › This computer): keep this computer awake while it has an active
 * schedule, and, on Windows and Linux, keep running in the tray when the
 * window closes. Both live in the desktop app's own settings; a desktop app
 * that predates them shows neither.
 */
export function DesktopBackgroundRows() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [options, setOptions] = useState<DesktopBackgroundOptions | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.desktopBridge
      ?.getBackgroundOptions?.()
      .then((loaded) => {
        if (!cancelled) setOptions(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (options === null || !bridge?.setBackgroundOptions) return null;

  const update = (patch: DesktopBackgroundOptionsPatch) => {
    void bridge.setBackgroundOptions?.(patch).then(setOptions, (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Couldn't save the setting",
        description: error instanceof Error ? error.message : undefined,
      });
    });
  };

  return (
    <>
      <SettingsRow
        title="Keep this computer awake for scheduled tasks"
        description="Stops it sleeping while it has an active scheduled task. The screen still turns off, and closing a laptop's lid still sleeps it."
        resetAction={
          options.keepAwakeForScheduledTasks ? (
            <SettingResetButton
              label="keep awake for scheduled tasks"
              onClick={() => update({ keepAwakeForScheduledTasks: false })}
            />
          ) : null
        }
        control={
          <Switch
            checked={options.keepAwakeForScheduledTasks}
            onCheckedChange={(checked) => update({ keepAwakeForScheduledTasks: Boolean(checked) })}
            aria-label="Keep this computer awake for scheduled tasks"
            data-testid="settings-keep-awake-for-scheduled-tasks"
          />
        }
      />
      {options.runInBackgroundSupported ? (
        <SettingsRow
          title="Keep running in the background when the window closes"
          description="Closing the window leaves Threadlines in the tray, so scheduled tasks and linked computers keep working. Quit from the tray."
          resetAction={
            options.runInBackground ? (
              <SettingResetButton
                label="keep running in the background"
                onClick={() => update({ runInBackground: false })}
              />
            ) : null
          }
          control={
            <Switch
              checked={options.runInBackground}
              onCheckedChange={(checked) => update({ runInBackground: Boolean(checked) })}
              aria-label="Keep running in the background when the window closes"
              data-testid="settings-run-in-background"
            />
          }
        />
      ) : null}
    </>
  );
}
