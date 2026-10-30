import type { DesktopBackgroundOptionsPatch } from "@threadlines/contracts";

import { Switch } from "../ui/switch";
import { failureNotice, toastManager } from "../ui/toast";
import {
  canSetDesktopBackgroundOptions,
  setDesktopBackgroundOptions,
  useDesktopBackgroundOptions,
} from "./desktopBackgroundOptions";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const save = (patch: DesktopBackgroundOptionsPatch) => {
  setDesktopBackgroundOptions(patch).catch((error: unknown) => {
    toastManager.add(
      failureNotice({
        title: "Couldn't save the setting",
        error,
      }),
    );
  });
};

/**
 * Keep this computer awake while it has an active schedule (Settings ›
 * General › This computer). Lives in the desktop app's own settings; a
 * desktop app that predates it shows nothing.
 */
export function KeepAwakeForScheduledTasksRow() {
  const options = useDesktopBackgroundOptions();
  if (options === null || !canSetDesktopBackgroundOptions()) return null;
  return (
    <SettingsRow
      place="general.keepAwakeForScheduledTasks"
      description="Stops it sleeping while it has an active scheduled task. The screen still turns off, and closing a laptop's lid still sleeps it."
      resetAction={
        options.keepAwakeForScheduledTasks ? (
          <SettingResetButton
            label="keep awake for scheduled tasks"
            onClick={() => save({ keepAwakeForScheduledTasks: false })}
          />
        ) : null
      }
      control={
        <Switch
          checked={options.keepAwakeForScheduledTasks}
          onCheckedChange={(checked) => save({ keepAwakeForScheduledTasks: Boolean(checked) })}
          aria-label="Keep this computer awake for scheduled tasks"
          data-testid="settings-keep-awake-for-scheduled-tasks"
        />
      }
    />
  );
}

/**
 * Keep running in the tray when the window closes, on Windows and Linux
 * (macOS always does). Lives in the desktop app's own settings.
 */
export function RunInBackgroundRow() {
  const options = useDesktopBackgroundOptions();
  if (options === null || !options.runInBackgroundSupported || !canSetDesktopBackgroundOptions()) {
    return null;
  }
  return (
    <SettingsRow
      place="general.runInBackground"
      description="Closing the window leaves Threadlines in the tray, so scheduled tasks and linked computers keep working. Quit from the tray."
      resetAction={
        options.runInBackground ? (
          <SettingResetButton
            label="keep running in the background"
            onClick={() => save({ runInBackground: false })}
          />
        ) : null
      }
      control={
        <Switch
          checked={options.runInBackground}
          onCheckedChange={(checked) => save({ runInBackground: Boolean(checked) })}
          aria-label="Keep running in the background when the window closes"
          data-testid="settings-run-in-background"
        />
      }
    />
  );
}

/** Both background rows, in the order the page shows them. */
export function DesktopBackgroundRows() {
  return (
    <>
      <KeepAwakeForScheduledTasksRow />
      <RunInBackgroundRow />
    </>
  );
}
