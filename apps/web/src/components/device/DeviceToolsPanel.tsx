import type {
  DeviceColorFilter,
  DeviceOrientation,
  DevicePermission,
  DeviceSummary,
  DeviceTextSize,
} from "@threadlines/contracts";
import type { DeviceHubTransport } from "@threadlines/client-runtime/device";
import { XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { DeviceEventLog } from "./DeviceEventLog";
import type { DeviceControls } from "./useDeviceControls";

const TEXT_SIZES: ReadonlyArray<{ value: DeviceTextSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "extra-large", label: "Extra large" },
];

const COLOR_FILTERS: ReadonlyArray<{ value: DeviceColorFilter; label: string }> = [
  { value: "none", label: "None" },
  { value: "grayscale", label: "Grayscale" },
  { value: "red-green", label: "Red / green (protanopia)" },
  { value: "green-red", label: "Green / red (deuteranopia)" },
  { value: "blue-yellow", label: "Blue / yellow (tritanopia)" },
];

const ORIENTATIONS: ReadonlyArray<{ value: DeviceOrientation; label: string }> = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape_left", label: "Landscape left" },
  { value: "portrait_upside_down", label: "Upside down" },
  { value: "landscape_right", label: "Landscape right" },
];

const IOS_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; label: string }> = [
  { value: "camera", label: "Camera" },
  { value: "microphone", label: "Microphone" },
  { value: "photos", label: "Photos" },
  { value: "contacts", label: "Contacts" },
  { value: "calendar", label: "Calendar" },
  { value: "reminders", label: "Reminders" },
  { value: "location", label: "Location" },
  { value: "notifications", label: "Notifications" },
  { value: "motion", label: "Motion" },
  { value: "media-library", label: "Media library" },
  { value: "faceid", label: "Face ID" },
];

const ANDROID_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; label: string }> = [
  { value: "camera", label: "Camera" },
  { value: "microphone", label: "Microphone" },
  { value: "photos", label: "Photos" },
  { value: "contacts", label: "Contacts" },
  { value: "calendar", label: "Calendar" },
  { value: "location", label: "Location" },
  { value: "notifications", label: "Notifications" },
  { value: "motion", label: "Physical activity" },
];

const LOCATION_PRESETS = [
  { label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { label: "New York", latitude: 40.7128, longitude: -74.006 },
  { label: "London", latitude: 51.5074, longitude: -0.1278 },
  { label: "Stockholm", latitude: 59.3293, longitude: 18.0686 },
  { label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
] as const;

/**
 * The device's settings and test actions. Every value shown is one the device
 * read back; a control the platform lacks is left out or disabled.
 */
export function DeviceToolsPanel(props: {
  readonly controls: DeviceControls;
  readonly device: DeviceSummary;
  readonly onClose: () => void;
  readonly className?: string;
  /** The device's hub transport, for the iOS event log. */
  readonly transport?: DeviceHubTransport;
}) {
  const { device, controls } = props;
  const { detail, pending, error, foregroundApp, disabled, act } = controls;
  const settings = detail?.settings;
  const ios = device.platform === "ios";

  return (
    <div
      data-testid="device-tools"
      className={cn("flex min-h-0 flex-col bg-background text-sm", props.className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <h2 className="text-[13px] font-medium">Tools</h2>
        {pending ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close tools"
          className="ml-auto"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {error ? (
          <p
            role="alert"
            className="px-3 pb-2 text-xs whitespace-pre-line text-destructive-foreground"
          >
            {error}
          </p>
        ) : null}
        {detail === null && !error ? (
          <p className="flex items-center gap-1.5 px-3 pb-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> Reading the device's settings…
          </p>
        ) : null}

        <Section title="App">
          <Row label="Open now">
            <span className="truncate font-mono text-xs">{foregroundApp?.id ?? "None"}</span>
          </Row>
          {foregroundApp ? (
            <div className="flex gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "terminateApp", appId: foregroundApp.id })}
              >
                Quit
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "launchApp", appId: foregroundApp.id })}
              >
                Relaunch
              </Button>
            </div>
          ) : null}
          <SubmitRow
            label="URL to open"
            placeholder="https://… or myapp://"
            action="Open"
            disabled={disabled}
            onSubmit={(url) => act({ type: "openUrl", url })}
          />
          <SubmitRow
            label="App to launch"
            placeholder={ios ? "Bundle ID" : "Package name"}
            action="Launch"
            disabled={disabled}
            onSubmit={(appId) => act({ type: "launchApp", appId })}
          />
          {ios ? (
            <div>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "shake" })}
              >
                Shake
              </Button>
            </div>
          ) : null}
        </Section>

        <Section title={ios ? "Simulator" : "Emulator"}>
          <Row label="Appearance">
            <SegmentedControl
              size="sm"
              aria-label="Appearance"
              value={settings?.appearance ?? "light"}
              disabled={disabled || settings?.appearance === undefined}
              onValueChange={(value) => void act({ type: "setAppearance", value })}
            >
              <SegmentedControlItem value="light">Light</SegmentedControlItem>
              <SegmentedControlItem value="dark">Dark</SegmentedControlItem>
            </SegmentedControl>
          </Row>
          <Row label="Text size">
            <ChoiceSelect
              label="Text size"
              value={settings?.textSize ?? null}
              options={TEXT_SIZES}
              disabled={disabled || settings?.textSize === undefined}
              onChange={(value) => act({ type: "setTextSize", value })}
            />
          </Row>
          {ios ? (
            <>
              <Row label="Liquid Glass">
                <SegmentedControl
                  size="sm"
                  aria-label="Liquid Glass"
                  value={settings?.liquidGlass ?? "clear"}
                  disabled={disabled || settings?.liquidGlass === undefined}
                  onValueChange={(value) => void act({ type: "setLiquidGlass", value })}
                >
                  <SegmentedControlItem value="clear">Clear</SegmentedControlItem>
                  <SegmentedControlItem value="tinted">Tinted</SegmentedControlItem>
                </SegmentedControl>
              </Row>
              <Row label="Color filter">
                <ChoiceSelect
                  label="Color filter"
                  value={settings?.colorFilter ?? null}
                  options={COLOR_FILTERS}
                  disabled={disabled || settings?.colorFilter === undefined}
                  onChange={(value) => act({ type: "setColorFilter", value })}
                />
              </Row>
            </>
          ) : (
            <Row label="Orientation">
              <ChoiceSelect
                label="Orientation"
                value={null}
                placeholder="Rotate to…"
                options={ORIENTATIONS}
                disabled={disabled}
                onChange={(value) => act({ type: "setOrientation", value })}
              />
            </Row>
          )}
          <SwitchRow
            label="Reduce Motion"
            checked={settings?.reduceMotion}
            disabled={disabled}
            onChange={(value) => act({ type: "setToggle", setting: "reduceMotion", value })}
          />
          {ios ? (
            <>
              <SwitchRow
                label="Increase Contrast"
                checked={settings?.increaseContrast}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "increaseContrast", value })}
              />
              <SwitchRow
                label="Reduce Transparency"
                checked={settings?.reduceTransparency}
                disabled={disabled}
                onChange={(value) =>
                  act({ type: "setToggle", setting: "reduceTransparency", value })
                }
              />
              <SwitchRow
                label="Show Borders"
                checked={settings?.showBorders}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "showBorders", value })}
              />
              <SwitchRow
                label="VoiceOver"
                checked={settings?.voiceOver}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "voiceOver", value })}
              />
            </>
          ) : (
            <SwitchRow
              label="Network"
              checked={settings?.networkEnabled}
              disabled={disabled}
              onChange={(value) => act({ type: "setToggle", setting: "networkEnabled", value })}
            />
          )}
        </Section>

        <LocationSection
          disabled={disabled}
          canClear={ios}
          onSet={(latitude, longitude) => act({ type: "setLocation", latitude, longitude })}
          onClear={() => act({ type: "clearLocation" })}
        />

        <PermissionsSection
          permissions={ios ? IOS_PERMISSIONS : ANDROID_PERMISSIONS}
          canReset={ios}
          defaultAppId={foregroundApp?.id ?? ""}
          disabled={disabled}
          onDecide={(appId, permission, decision) =>
            act({ type: "setPermission", appId, permission, decision })
          }
        />

        {ios ? (
          <Section title="Test push">
            <SubmitRow
              label="Notification text"
              placeholder="Alert text"
              action="Send"
              disabled={disabled || !foregroundApp}
              onSubmit={(payload) =>
                foregroundApp
                  ? act({ type: "sendPush", appId: foregroundApp.id, payload })
                  : Promise.resolve(false)
              }
            />
            {!foregroundApp ? (
              <p className="text-xs text-muted-foreground">
                Open an app first; the push goes to it.
              </p>
            ) : null}
          </Section>
        ) : null}

        {ios && props.transport ? (
          <Section title="Event log">
            <DeviceEventLog key={device.id} transport={props.transport} deviceId={device.id} />
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-3 pt-3">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="shrink-0 text-[13px]">{props.label}</span>
      <div className="flex min-w-0 items-center justify-end">{props.children}</div>
    </div>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly checked: boolean | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => Promise<unknown>;
}) {
  return (
    <Row label={props.label}>
      <Switch
        size="sm"
        aria-label={props.label}
        checked={props.checked ?? false}
        disabled={props.disabled || props.checked === undefined}
        onCheckedChange={(checked) => void props.onChange(checked)}
      />
    </Row>
  );
}

function ChoiceSelect<V extends string>(props: {
  readonly label: string;
  readonly value: V | null;
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: string }>;
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly onChange: (value: V) => Promise<unknown>;
}) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null && value !== props.value) void props.onChange(value as V);
      }}
    >
      <SelectTrigger size="xs" className="w-40 min-w-0" aria-label={props.label}>
        <SelectValue>
          {current ? (
            current.label
          ) : (
            <span className="text-muted-foreground">{props.placeholder ?? "Unknown"}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SubmitRow(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly action: string;
  readonly disabled: boolean;
  readonly onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) return;
        void props.onSubmit(trimmed).then((sent) => {
          if (sent) setValue("");
        });
      }}
    >
      <Input
        size="sm"
        className="min-w-0 flex-1 font-mono"
        aria-label={props.label}
        placeholder={props.placeholder}
        value={value}
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button
        type="submit"
        size="xs"
        variant="outline"
        className="self-center"
        disabled={props.disabled || value.trim().length === 0}
      >
        {props.action}
      </Button>
    </form>
  );
}

function LocationSection(props: {
  readonly disabled: boolean;
  readonly canClear: boolean;
  readonly onSet: (latitude: number, longitude: number) => Promise<unknown>;
  readonly onClear: () => Promise<unknown>;
}) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid =
    latitude.trim() !== "" &&
    longitude.trim() !== "" &&
    Number.isFinite(parsed.latitude) &&
    Number.isFinite(parsed.longitude) &&
    Math.abs(parsed.latitude) <= 90 &&
    Math.abs(parsed.longitude) <= 180;
  return (
    <Section title="Location">
      <div className="flex gap-1.5">
        <Input
          size="sm"
          className="min-w-0 flex-1 font-mono"
          aria-label="Latitude"
          placeholder="Latitude"
          inputMode="decimal"
          value={latitude}
          disabled={props.disabled}
          onChange={(event) => setLatitude(event.target.value)}
        />
        <Input
          size="sm"
          className="min-w-0 flex-1 font-mono"
          aria-label="Longitude"
          placeholder="Longitude"
          inputMode="decimal"
          value={longitude}
          disabled={props.disabled}
          onChange={(event) => setLongitude(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select<string | null>
          value={null}
          disabled={props.disabled}
          onValueChange={(value) => {
            const preset = LOCATION_PRESETS.find((candidate) => candidate.label === value);
            if (!preset) return;
            setLatitude(String(preset.latitude));
            setLongitude(String(preset.longitude));
            void props.onSet(preset.latitude, preset.longitude);
          }}
        >
          <SelectTrigger size="xs" className="w-32 min-w-0" aria-label="Location preset">
            <SelectValue>
              <span className="text-muted-foreground">City…</span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {LOCATION_PRESETS.map((preset) => (
              <SelectItem key={preset.label} value={preset.label}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !valid}
          onClick={() => void props.onSet(parsed.latitude, parsed.longitude)}
        >
          Set
        </Button>
        {props.canClear ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => {
              setLatitude("");
              setLongitude("");
              void props.onClear();
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function PermissionsSection(props: {
  readonly permissions: ReadonlyArray<{ value: DevicePermission; label: string }>;
  readonly canReset: boolean;
  readonly defaultAppId: string;
  readonly disabled: boolean;
  readonly onDecide: (
    appId: string,
    permission: DevicePermission,
    decision: "grant" | "revoke" | "reset",
  ) => Promise<unknown>;
}) {
  const [appId, setAppId] = useState("");
  const [permission, setPermission] = useState<DevicePermission>("camera");
  const resolvedAppId = appId.trim() || props.defaultAppId;
  const decide = (decision: "grant" | "revoke" | "reset") =>
    void props.onDecide(resolvedAppId, permission, decision);
  return (
    <Section title="Permissions">
      <Input
        size="sm"
        className="font-mono"
        aria-label="App for permissions"
        placeholder={props.defaultAppId || "App ID"}
        value={appId}
        disabled={props.disabled}
        onChange={(event) => setAppId(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <ChoiceSelect
          label="Permission"
          value={permission}
          options={props.permissions}
          disabled={props.disabled}
          onChange={(value) => {
            setPermission(value);
            return Promise.resolve();
          }}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("grant")}
        >
          Grant
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("revoke")}
        >
          Revoke
        </Button>
        {props.canReset ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled || !resolvedAppId}
            onClick={() => decide("reset")}
          >
            Reset
          </Button>
        ) : null}
      </div>
    </Section>
  );
}
