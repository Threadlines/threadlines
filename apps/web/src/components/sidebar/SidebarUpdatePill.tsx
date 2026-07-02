import { TriangleAlertIcon } from "lucide-react";
import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../lib/desktopUpdateReactQuery";
import {
  getArm64IntelBuildWarningDescription,
  shouldShowArm64IntelBuildWarning,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { UPDATE_STATUS_SURFACE_STYLES } from "./updateStatusVisuals";
import { cn } from "~/lib/utils";

export function SidebarUpdatePill() {
  const state = useDesktopUpdateState().data ?? null;
  const showArm64Warning = isElectron && shouldShowArm64IntelBuildWarning(state);
  const arm64Description =
    state && showArm64Warning ? getArm64IntelBuildWarningDescription(state) : null;

  if (!showArm64Warning || !arm64Description) return null;

  return (
    <Alert
      variant="warning"
      className={cn("rounded-md text-xs", UPDATE_STATUS_SURFACE_STYLES.warning)}
    >
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{arm64Description}</AlertDescription>
    </Alert>
  );
}
