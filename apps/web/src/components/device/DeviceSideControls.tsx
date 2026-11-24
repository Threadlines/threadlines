import type {
  AndroidFoldPosture,
  DeviceScreenSize,
  DuoCommand,
  DuoControlState,
  DuoPose,
} from "@threadlines/client-runtime/device";
import { duoPose } from "@threadlines/client-runtime/device";
import { CircleAlertIcon, TableIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { DeviceDuoGlyph } from "./DeviceDuoGlyph";
import type { AndroidFold } from "./useAndroidFold";

/**
 * A narrow column of plain buttons beside the device's screen for its
 * hardware: an iPhone Duo's stances, an Android foldable's fold.
 */
function SideRail(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label={props.label}
      data-testid="device-side-controls"
      className="flex shrink-0 flex-col items-center justify-center gap-0.5 py-2 pr-1.5"
    >
      {props.children}
    </div>
  );
}

function RailButton(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={props.label}
      tooltip={props.label}
      tooltipSide="left"
      aria-pressed={props.pressed}
      data-pressed={props.pressed ? "" : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function RailError(props: { readonly message: string }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      role="alert"
      aria-label={props.message}
      tooltip={props.message}
      tooltipSide="left"
      className="text-destructive-foreground"
    >
      <CircleAlertIcon />
    </Button>
  );
}

const DUO_STANCES: ReadonlyArray<{ readonly pose: DuoPose; readonly label: string }> = [
  { pose: "closed", label: "Closed" },
  { pose: "book", label: "Book" },
  { pose: "open", label: "Open" },
];
const DUO_STANDS: ReadonlyArray<{ readonly pose: DuoPose; readonly label: string }> = [
  { pose: "laptop", label: "Laptop" },
  { pose: "tent", label: "Tent" },
];

/** iPhone Duo: the fold (closed, book, open), the stands (laptop, tent), and table mode where offered. */
export function DeviceDuoControls(props: {
  readonly screen: DeviceScreenSize;
  readonly control: DuoControlState;
  readonly enabled: boolean;
  readonly onCommand: (command: DuoCommand) => void;
}) {
  const { screen, control } = props;
  // A stance on its way shows as chosen; the helper's next config confirms it.
  const requested = control.requested?.control === "pose" ? control.requested.value : null;
  const current = requested ?? duoPose(screen);
  const button = ({ pose, label }: { readonly pose: DuoPose; readonly label: string }) => (
    <RailButton
      key={pose}
      label={label}
      pressed={current === pose}
      disabled={!props.enabled}
      onClick={() => props.onCommand({ control: "pose", value: pose })}
    >
      <DeviceDuoGlyph pose={pose} />
    </RailButton>
  );
  return (
    <SideRail label="iPhone Duo stance">
      {DUO_STANCES.map(button)}
      <span aria-hidden className="my-1 h-px w-4 bg-border" />
      {DUO_STANDS.map(button)}
      {screen.tableModeAvailable || screen.tableMode ? (
        <RailButton
          label={screen.tableMode ? "Table mode on" : "Table mode"}
          pressed={screen.tableMode === true}
          disabled={!props.enabled}
          onClick={() => props.onCommand({ control: "table", value: screen.tableMode !== true })}
        >
          <TableIcon />
        </RailButton>
      ) : null}
      {control.error ? <RailError message={control.error} /> : null}
    </SideRail>
  );
}

/** Android foldable: fold and unfold. */
export function DeviceFoldControls(props: {
  readonly fold: AndroidFold;
  readonly enabled: boolean;
}) {
  const { fold } = props.fold;
  if (!fold?.supported) return null;
  const button = (posture: AndroidFoldPosture, label: string, pose: DuoPose) => (
    <RailButton
      label={label}
      pressed={posture === "closed" ? fold.posture === "closed" : fold.posture === "opened"}
      disabled={!props.enabled || props.fold.pending}
      onClick={() => props.fold.change(posture)}
    >
      <DeviceDuoGlyph pose={pose} />
    </RailButton>
  );
  return (
    <SideRail label="Fold">
      {button("closed", "Fold", "closed")}
      {button("opened", "Unfold", "open")}
      {props.fold.error ? <RailError message={props.fold.error} /> : null}
    </SideRail>
  );
}
