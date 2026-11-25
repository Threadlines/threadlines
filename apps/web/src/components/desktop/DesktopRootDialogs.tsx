import { DesktopUpdateInstallDialog } from "./DesktopUpdateInstallDialog";
import { QuitConfirmationDialog } from "./QuitConfirmationDialog";
import { SshPasswordPromptDialog } from "./SshPasswordPromptDialog";

/**
 * Root dialogs driven by the Electron preload bridge and desktop updater.
 * Loaded in a separate chunk so web and phone clients never download them;
 * desktop preloads this chunk immediately at startup.
 */
export function DesktopRootDialogs() {
  return (
    <>
      <SshPasswordPromptDialog />
      <QuitConfirmationDialog />
      <DesktopUpdateInstallDialog />
    </>
  );
}
