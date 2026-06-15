import { TriangleAlertIcon } from "lucide-react";
import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../lib/desktopUpdateReactQuery";
import {
  getArm64IntelBuildWarningDescription,
  shouldShowArm64IntelBuildWarning,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

export function SidebarUpdatePill() {
  const state = useDesktopUpdateState().data ?? null;
  const showArm64Warning = isElectron && shouldShowArm64IntelBuildWarning(state);
  const arm64Description =
    state && showArm64Warning ? getArm64IntelBuildWarningDescription(state) : null;

  if (!showArm64Warning || !arm64Description) return null;

  return (
    <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8 text-xs">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{arm64Description}</AlertDescription>
    </Alert>
  );
}
