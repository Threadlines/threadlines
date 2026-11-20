/**
 * List, boot, shut down and screenshot through the device hub, with the hub's
 * session token on every request (docs/design/devices.md). Ported from T3
 * Code's DeviceHubOperations.
 */
import {
  DeviceBootError,
  DeviceOperationError,
  type DevicePlatform,
  type DeviceSummary,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { DeviceHostReady, DeviceOperations } from "./DeviceHost.ts";

type HostDevice = DeviceSummary;

const BOOT_TIMEOUT = Duration.minutes(3);
const SCREENSHOT_TIMEOUT = Duration.seconds(20);
// Let the hub's 30 s simctl timeout report its cause first.
const LIST_TIMEOUT_SECONDS = 40;
// expo-device-hub 0.19.1 reports a failed simulator listing only as text; its error ids are hashes.
const SIMULATOR_LIST_FAILED =
  /^\[apple-utils\] (?:Failed to (?:run `xcrun simctl list devices|parse JSON output:|list devices:)|`xcrun simctl list devices --json` did not respond within )/;
// The hub passes numeric display IDs that Xcode 26 rejects; iOS 27 needs them for multiple displays.
// expo-device-hub 0.22.1 returns no Android devices when avdmanager fails, before it runs adb.
const AVDMANAGER_LIST_FAILED = "[android-utils] Failed to run `avdmanager list avd`";
const GETPROP_LINE = /^\[([^\]]+)\]: \[(.*)\]$/;
// An AVD name as `emulator -list-avds` prints it; anything else is never joined into a path.
const AVD_NAME = /^[A-Za-z0-9._-]+$/;
const runsOnXcode26Runtime = (version: string) => Number(/^iOS (\d+)/.exec(version)?.[1]) <= 26;
// simctl needs a real file (it writes "-" or /dev/stdout as a file of that
// name), so the PNG passes through one in Threadlines' own state folder ($2),
// removed on exit, never the user's temp folder.
const DEFAULT_DISPLAY_SCREENSHOT = `mkdir -p "$2" && f=$(mktemp "$2/screenshot.XXXXXX") || exit 1
trap 'rm -f "$f"' 0
xcrun simctl io "$1" screenshot --type=png "$f" >/dev/null && base64 -i "$f"`;

const HubDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  booted: Schema.Boolean,
  physical: Schema.Boolean,
});
const HubDeviceList = Schema.Struct({
  simulators: Schema.Array(HubDevice),
  emulators: Schema.Array(HubDevice),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String, error: Schema.optional(Schema.String) })),
  ),
});
/** An iOS simulator runtime's name: its version, then a model for a device-specific build. */
const IOS_RUNTIME = /^iOS-(\d+(?:-\d+)*)(?:-[A-Za-z][A-Za-z0-9-]*)?$/;

/** serve-sim's grid inventory, which, unlike `/api/devices`, includes simulators never booted. */
const IosGridDeviceList = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      device: Schema.String,
      name: Schema.String,
      runtime: Schema.String,
      state: Schema.String,
    }),
  ),
});
const HubActionResult = Schema.Struct({
  ok: Schema.Boolean,
  id: Schema.optional(Schema.String),
  serial: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String, error: Schema.optional(Schema.String) })),
  ),
});

const SimctlDevices = Schema.Struct({
  devices: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({ udid: Schema.String, deviceTypeIdentifier: Schema.optional(Schema.String) }),
    ),
  ),
});
const decodeSimctlDevices = Schema.decodeUnknownOption(Schema.fromJsonString(SimctlDevices));

/**
 * Each simulator's device type (`com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`)
 * by upper-case UDID, from `xcrun simctl list devices -j`. Empty when the
 * output is not that listing.
 */
export const parseSimctlDeviceTypes = (stdout: string): ReadonlyMap<string, string> => {
  const parsed = decodeSimctlDevices(stdout);
  const types = new Map<string, string>();
  if (Option.isNone(parsed)) return types;
  for (const devices of Object.values(parsed.value.devices)) {
    for (const device of devices) {
      const type = device.deviceTypeIdentifier?.trim();
      if (type) types.set(device.udid.toUpperCase(), type);
    }
  }
  return types;
};

/** One `key = value` (or `key=value`) from an AVD's `.ini` or `config.ini`. */
export const readIniValue = (text: string, key: string): string | undefined => {
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator === -1 || line.slice(0, separator).trim() !== key) continue;
    const value = line.slice(separator + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
};

/** A failure's class and first line, never a stack: this text reaches the browser. */
const briefCause = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const tag = "_tag" in cause && typeof cause._tag === "string" ? cause._tag : undefined;
  const message =
    "message" in cause && typeof cause.message === "string"
      ? cause.message.split(/\r?\n/)[0]
      : undefined;
  const text = [tag, message].filter(Boolean).join(": ");
  return text ? boundDiagnostics(text) : undefined;
};

// Hub diagnostics can carry a whole stderr dump.
const boundDiagnostics = (text: string) =>
  text.length > 2_000 ? `${text.slice(0, 1_999)}…` : text;

// The hub's `error` is a util.inspect of Node's exec error; the stack and the
// inspected fields follow the first frame, so keep the lines before it.
const errorHead = (error: string) => {
  const lines = error.split(/\r?\n/);
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  return (firstFrame === -1 ? lines : lines.slice(0, firstFrame))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
};

const vendorPrefix = (platform: DevicePlatform) =>
  platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";

/**
 * What a device is never changes: a simulator's device type by UDID and a
 * phone's model by serial. An emulator's profile is read again each listing
 * (one small file), since a serial is reused across AVDs.
 */
export interface DeviceModelCache {
  readonly simulatorTypes: Map<string, string | null>;
  readonly phoneModels: Map<string, string | null>;
}

export const makeDeviceModelCache = (): DeviceModelCache => ({
  simulatorTypes: new Map(),
  phoneModels: new Map(),
});

export interface DeviceHubOperationsOptions {
  readonly origin: string;
  /** The hub's session token (`--require-token`), sent as a bearer on every request. */
  readonly token: string;
  readonly http: HttpClient.HttpClient;
  readonly run: DeviceHostReady["run"];
  /** Android gates listing AVDs, which the hub does not report until they boot. */
  readonly platformAvailable: (platform: DevicePlatform) => Effect.Effect<boolean>;
  /** A folder in the server's state dir for files a command must write (screenshots). */
  readonly scratchDir: string;
  /** Kept by the host across hub starts, so a refresh does not ask simctl or adb again. */
  readonly modelCache: DeviceModelCache;
  /**
   * Where the AVDs live (`ANDROID_AVD_HOME`, else `~/.android/avd`), and a
   * reader for their `.ini` files: an emulator's hardware profile becomes its
   * `model`. Without them Android devices list without one.
   */
  readonly androidAvds?: {
    readonly home: string;
    readonly readTextFile: (path: string) => Effect.Effect<string | undefined>;
  };
}

/**
 * How a host makes device operations for each hub start: made once per host,
 * it keeps the model cache for the host's whole life, so asking again for an
 * already running hub (every picker refresh) does not run simctl or adb again.
 */
export const makeHostDeviceOperations = (
  options: Omit<DeviceHubOperationsOptions, "origin" | "token" | "modelCache">,
) => {
  const modelCache = makeDeviceModelCache();
  return (hub: { readonly origin: string; readonly token: string }) =>
    makeDeviceHubOperations({ ...options, ...hub, modelCache });
};

/** Device operations for one running hub. Hosts make them through `makeHostDeviceOperations`. */
export const makeDeviceHubOperations = (options: DeviceHubOperationsOptions): DeviceOperations => {
  const { origin, run } = options;
  const { simulatorTypes, phoneModels } = options.modelCache;
  const httpClient = options.http.pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(options.token)),
    HttpClient.withScope,
  );

  const fetchJson = Effect.fn("DeviceHubOperations.fetchJson")(function* <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
  ) {
    return yield* httpClient
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.scoped,
      );
  });

  const hubJson = <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
    operation: string,
    timeout: Duration.Input = Duration.seconds(15),
  ) =>
    fetchJson(request, schema).pipe(
      Effect.timeout(timeout),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({
            operation,
            reason: "request_failed",
            detail: briefCause(cause),
          }),
      ),
    );

  const postJson = (path: string, body: Record<string, string>, operation: string) =>
    HttpClientRequest.post(`${origin}${path}`).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.mapError(() => new DeviceOperationError({ operation, reason: "invalid_payload" })),
    );

  // Booting alone does not attach a serve-sim helper; the grid start does both
  // and is idempotent for a booted simulator.
  const attachIosStream = (udid: string, operation: string) =>
    postJson(`${vendorPrefix("ios")}/grid/api/start`, { udid }, operation).pipe(
      Effect.flatMap((request) => hubJson(request, HubActionResult, "attach stream", BOOT_TIMEOUT)),
    );

  // Mirrors the hub's own adb discovery for when it skips it.
  const listAdbDevices = Effect.gen(function* () {
    const listed = yield* run("adb", ["devices", "-l"]);
    if (listed.code !== 0) return undefined;
    const serials = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .flatMap(([serial, state]) => (serial && state === "device" ? [serial] : []));
    return yield* Effect.forEach(serials, (serial) =>
      Effect.gen(function* () {
        const getprop = yield* run("adb", ["-s", serial, "shell", "getprop"]);
        const props = new Map(
          getprop.stdout.split(/\r?\n/).flatMap((line) => {
            const match = GETPROP_LINE.exec(line.trim());
            return match ? [[match[1]!, match[2]!] as const] : [];
          }),
        );
        const emulator = props.get("ro.kernel.qemu") === "1" || props.get("ro.boot.qemu") === "1";
        const avdName = emulator
          ? (yield* run("adb", ["-s", serial, "emu", "avd", "name"])).stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find((line) => line && line !== "OK" && !line.startsWith("KO"))
          : undefined;
        const model = props.get("ro.product.model");
        const manufacturer = props.get("ro.product.manufacturer");
        const release = props.get("ro.build.version.release");
        return {
          id: serial,
          name: emulator
            ? (avdName ?? serial)
            : model
              ? [manufacturer, model].filter(Boolean).join(" ")
              : serial,
          platform: "android",
          version: release
            ? `Android ${/^\d+$/.test(release) ? `${release}.0` : release}`
            : "Android",
          booted: true,
          physical: !emulator,
        } satisfies HostDevice;
      }),
    );
  });

  /** Asks simctl once for every simulator whose type is not known yet. */
  const simulatorModels = Effect.fn("DeviceHubOperations.simulatorModels")(function* (
    udids: ReadonlyArray<string>,
  ) {
    if (udids.some((udid) => !simulatorTypes.has(udid.toUpperCase()))) {
      const listed = yield* run("xcrun", ["simctl", "list", "devices", "-j"], {
        timeoutMs: 30_000,
        maxOutputBytes: 16 * 1024 * 1024,
      });
      if (listed.code === 0) {
        const types = parseSimctlDeviceTypes(listed.stdout);
        for (const [udid, type] of types) simulatorTypes.set(udid, type);
        // simctl answered without these: they are not simulators it knows, so don't ask again.
        for (const udid of udids) {
          if (!simulatorTypes.has(udid.toUpperCase())) simulatorTypes.set(udid.toUpperCase(), null);
        }
      }
    }
  });

  /** An emulator's hardware profile (`hw.device.name`), through its AVD's `.ini`. */
  const emulatorModel = (avdName: string) => {
    const avds = options.androidAvds;
    if (!avds || !AVD_NAME.test(avdName)) return Effect.succeed(undefined);
    return Effect.gen(function* () {
      const pointer = yield* avds.readTextFile(`${avds.home}/${avdName}.ini`);
      const folder = (pointer && readIniValue(pointer, "path")) ?? `${avds.home}/${avdName}.avd`;
      const config = yield* avds.readTextFile(`${folder}/config.ini`);
      return config ? readIniValue(config, "hw.device.name") : undefined;
    });
  };

  const phoneModel = Effect.fn("DeviceHubOperations.phoneModel")(function* (serial: string) {
    const known = phoneModels.get(serial);
    if (known !== undefined) return known ?? undefined;
    const read = yield* run("adb", ["-s", serial, "shell", "getprop", "ro.product.model"]);
    if (read.code !== 0) return undefined;
    const model = read.stdout.trim() || null;
    phoneModels.set(serial, model);
    return model ?? undefined;
  });

  /** Fills in `model` where it can be told; a lookup that fails leaves it out. */
  const withModels = Effect.fn("DeviceHubOperations.withModels")(function* (
    devices: ReadonlyArray<HostDevice>,
  ) {
    const simulators = devices.filter((device) => device.platform === "ios" && !device.physical);
    if (simulators.length > 0) yield* simulatorModels(simulators.map((device) => device.id));
    return yield* Effect.forEach(
      devices,
      (device) =>
        Effect.gen(function* () {
          if (device.model) return device;
          const model =
            device.platform === "ios"
              ? device.physical
                ? undefined
                : (simulatorTypes.get(device.id.toUpperCase()) ?? undefined)
              : device.physical
                ? device.booted
                  ? yield* phoneModel(device.id)
                  : undefined
                : yield* emulatorModel(device.name);
          return model ? { ...device, model } : device;
        }),
      { concurrency: 4 },
    );
  });

  const list: DeviceOperations["list"] = Effect.gen(function* () {
    const listed = yield* fetchJson(
      HttpClientRequest.get(`${origin}/api/devices`),
      HubDeviceList,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({
            operation: "list",
            reason: "request_failed",
            detail: briefCause(cause),
          }),
      ),
      Effect.timeoutOption(Duration.seconds(LIST_TIMEOUT_SECONDS)),
    );
    if (Option.isNone(listed)) {
      return {
        devices: [],
        detail: `The device hub did not answer within ${LIST_TIMEOUT_SECONDS} seconds.`,
        incompletePlatforms: yield* Effect.filter(["ios", "android"] as const, (platform) =>
          options.platformAvailable(platform),
        ),
      };
    }
    const hubList = listed.value;
    const devices: Array<HostDevice> = [...hubList.simulators, ...hubList.emulators];
    const androidAvailable = yield* options.platformAvailable("android");
    const warnings = hubList.errors?.filter(
      (error) =>
        // The host summary already explains a missing Android SDK; the hub's failed probes are noise.
        !(!androidAvailable && error.message.startsWith("[android-utils] ")) &&
        // CoreSimulator can retain deleted devices; their optional usage timestamps are absent.
        !(
          error.message.startsWith("[apple-utils] Failed to read CoreSimulator plist at ") &&
          /\/CoreSimulator\/Devices\/[^/]+\/device\.plist:$/.test(error.message) &&
          /(?:^Error:\s*ENOENT:|\bcode:\s*['"]ENOENT['"])/.test(error.error ?? "")
        ),
    );
    const details =
      warnings?.map((error) => {
        const head = errorHead(error.error ?? "");
        return boundDiagnostics(head ? `${error.message} ${head}` : error.message);
      }) ?? [];
    // The hub's device list leaves out simulators that were never booted (they
    // carry no usage timestamps); serve-sim's grid lists them. Ported from T3
    // Code's fix (pingdotgg/t3code#28915).
    if (yield* options.platformAvailable("ios")) {
      const grid = yield* hubJson(
        HttpClientRequest.get(`${origin}${vendorPrefix("ios")}/grid/api`),
        IosGridDeviceList,
        "list",
      ).pipe(Effect.result);
      if (grid._tag === "Failure") {
        details.push("Could not list all iOS simulators. Recently used ones are listed.");
      } else {
        for (const device of grid.success.devices) {
          const known = devices.some(
            (listed) =>
              listed.platform === "ios" && listed.id.toUpperCase() === device.device.toUpperCase(),
          );
          // `iOS-27-2`, or a runtime made for one model, such as the iPhone
          // Duo's `iOS-27-2-iPhone19-4`.
          const iosVersion = IOS_RUNTIME.exec(device.runtime)?.[1];
          if (known || iosVersion === undefined) continue;
          devices.push({
            id: device.device,
            name: device.name,
            version: `iOS ${iosVersion.replaceAll("-", ".")}`,
            platform: "ios",
            booted: device.state === "Booted",
            physical: false,
          });
        }
      }
    }
    if (androidAvailable) {
      if (hubList.errors?.some((error) => error.message.startsWith(AVDMANAGER_LIST_FAILED))) {
        const adbDevices = yield* listAdbDevices;
        if (adbDevices === undefined) {
          details.push("Could not list Android devices (adb devices -l).");
        } else {
          devices.push(...adbDevices);
        }
      }
      const avds = yield* run("emulator", ["-list-avds"]);
      // Discovered devices stay listed; the AVDs that could not be listed are a warning.
      if (avds.code !== 0) {
        details.push(
          `Could not list Android virtual devices (emulator -list-avds, exit code ${avds.code}). Discovered devices remain available.`,
        );
      }
      for (const name of (avds.code === 0 ? avds.stdout : "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (!devices.some((device) => device.platform === "android" && device.name === name)) {
          devices.push({
            id: name,
            name,
            platform: "android",
            version: "Android",
            booted: false,
            physical: false,
          });
        }
      }
    }
    const modelled = yield* withModels(devices);
    const simulatorsUnlisted =
      hubList.simulators.length === 0 &&
      (hubList.errors ?? []).some((error) => SIMULATOR_LIST_FAILED.test(error.message));
    return {
      devices: modelled,
      detail: details.join("\n") || undefined,
      incompletePlatforms: simulatorsUnlisted ? (["ios"] as const) : [],
    };
  }).pipe(Effect.withSpan("DeviceHubOperations.list"));

  const boot: DeviceOperations["boot"] = Effect.fn("DeviceHubOperations.boot")(function* (device) {
    const result = yield* postJson(
      "/api/devices/boot",
      { platform: device.platform, id: device.id, name: device.name },
      "boot",
    ).pipe(Effect.flatMap((request) => hubJson(request, HubActionResult, "boot", BOOT_TIMEOUT)));
    if (!result.ok) {
      // Keep the hub's launch command and nested failure available to agents for recovery.
      const diagnostics = [
        result.error,
        ...(result.errors ?? []).flatMap((error) => [error.message, error.error]),
      ]
        .filter((text) => text?.trim())
        .join("\n\n");
      return yield* new DeviceBootError({
        deviceId: device.id,
        reason: /insufficient.*(?:disk|space)|not enough.*(?:disk|space)|no space left/i.test(
          diagnostics,
        )
          ? "disk_space"
          : /timed? out|timeout/i.test(diagnostics)
            ? "timeout"
            : "launch_failed",
        ...(diagnostics ? { diagnostics: boundDiagnostics(diagnostics) } : {}),
      });
    }
    if (device.platform === "ios") yield* attachIosStream(device.id, "boot");
    return result.serial ?? result.id ?? device.id;
  });

  const attach: DeviceOperations["attach"] = (device) =>
    device.platform === "ios"
      ? attachIosStream(device.id, "open").pipe(Effect.asVoid)
      : Effect.void;

  const shutdown: DeviceOperations["shutdown"] = Effect.fn("DeviceHubOperations.shutdown")(
    function* (device) {
      const postShutdown = (path: string, body: Record<string, string>) =>
        postJson(path, body, "shutdown").pipe(
          Effect.flatMap((request) => hubJson(request, HubActionResult, "shutdown")),
          Effect.flatMap((result) =>
            result.ok
              ? Effect.void
              : Effect.fail(
                  new DeviceOperationError({
                    operation: "shutdown",
                    reason: "hub_rejected",
                    ...(result.error ? { detail: boundDiagnostics(errorHead(result.error)) } : {}),
                  }),
                ),
          ),
        );
      // serve-sim's shutdown closes its in-process capture session before it
      // runs `simctl shutdown`; the hub's generic shutdown can leave that
      // session cached across a reboot. serve-sim runs simctl bare, though, so
      // a simulator that is already off fails there.
      yield* device.platform === "ios"
        ? postShutdown(`${vendorPrefix("ios")}/grid/api/shutdown`, { udid: device.id }).pipe(
            Effect.catch((cause) =>
              list.pipe(
                Effect.flatMap(({ devices }) =>
                  devices.find((candidate) => candidate.id === device.id)?.booted === false
                    ? Effect.logInfo("iOS simulator was already shut down", { deviceId: device.id })
                    : Effect.fail(cause),
                ),
              ),
            ),
          )
        : postShutdown("/api/devices/shutdown", { platform: device.platform, id: device.id });
    },
  );

  const defaultDisplayScreenshot = Effect.fn("DeviceHubOperations.defaultDisplayScreenshot")(
    function* (udid: string) {
      const capture = yield* run(
        "sh",
        ["-c", DEFAULT_DISPLAY_SCREENSHOT, "sh", udid, options.scratchDir],
        {
          timeoutMs: Duration.toMillis(SCREENSHOT_TIMEOUT),
          maxOutputBytes: 64 * 1024 * 1024,
        },
      );
      if (capture.code !== 0) {
        return yield* new DeviceOperationError({
          operation: "screenshot",
          reason: "command_failed",
          exitCode: capture.code,
          detail: boundDiagnostics(capture.stderr.trim()),
        });
      }
      return new Uint8Array(Buffer.from(capture.stdout, "base64"));
    },
  );

  const screenshot: DeviceOperations["screenshot"] = (device) =>
    httpClient
      .execute(
        HttpClientRequest.post(
          `${origin}${vendorPrefix(device.platform)}/api/screenshot?device=${encodeURIComponent(device.id)}`,
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.scoped,
        Effect.timeout(SCREENSHOT_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "screenshot",
              reason:
                HttpClientError.isHttpClientError(cause) && cause.reason._tag === "StatusCodeError"
                  ? "hub_rejected"
                  : "request_failed",
            }),
        ),
        Effect.catchIf(
          (error) =>
            device.platform === "ios" &&
            runsOnXcode26Runtime(device.version) &&
            error.reason === "hub_rejected",
          () => defaultDisplayScreenshot(device.id),
        ),
        Effect.withSpan("DeviceHubOperations.screenshot"),
      );

  return { list, boot, attach, shutdown, screenshot };
};
