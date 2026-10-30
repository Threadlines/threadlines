import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const firstSomeOption = <A>(
  configs: ReadonlyArray<Config.Config<Option.Option<A>>>,
): Config.Config<Option.Option<A>> =>
  Config.all(configs).pipe(Config.map((values) => values.find(Option.isSome) ?? Option.none<A>()));

const trimmedStringAlias = (
  threadlinesName: string,
  badcodeName: string,
  legacyT3CodeName: string,
) =>
  firstSomeOption([
    trimmedString(threadlinesName),
    trimmedString(badcodeName),
    trimmedString(legacyT3CodeName),
  ]);

const optionalBooleanAlias = (
  threadlinesName: string,
  badcodeName: string,
  legacyT3CodeName: string,
) =>
  firstSomeOption([
    Config.Boolean(threadlinesName).pipe(Config.option),
    Config.Boolean(badcodeName).pipe(Config.option),
    Config.Boolean(legacyT3CodeName).pipe(Config.option),
  ]).pipe(Config.map((value) => Option.getOrElse(value, () => false)));

const optionalPortAlias = (
  threadlinesName: string,
  badcodeName: string,
  legacyT3CodeName: string,
) =>
  firstSomeOption([
    Config.Port(threadlinesName).pipe(Config.option),
    Config.Port(badcodeName).pipe(Config.option),
    Config.Port(legacyT3CodeName).pipe(Config.option),
  ]);

const intAliasWithDefault = (
  threadlinesName: string,
  badcodeName: string,
  legacyT3CodeName: string,
  defaultValue: number,
) =>
  firstSomeOption([
    Config.Int(threadlinesName).pipe(Config.option),
    Config.Int(badcodeName).pipe(Config.option),
    Config.Int(legacyT3CodeName).pipe(Config.option),
  ]).pipe(Config.map((value) => Option.getOrElse(value, () => defaultValue)));

const commaSeparatedStringsOption = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.map((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    ),
  );

const commaSeparatedStringsAlias = (
  threadlinesName: string,
  badcodeName: string,
  legacyT3CodeName: string,
) =>
  firstSomeOption([
    commaSeparatedStringsOption(threadlinesName),
    commaSeparatedStringsOption(badcodeName),
    commaSeparatedStringsOption(legacyT3CodeName),
  ]).pipe(Config.map(Option.getOrElse(() => [])));

const portAliasWithDefault = (
  threadlinesName: string,
  badcodeName: string,
  legacyT3CodeName: string,
  defaultValue: number,
) =>
  optionalPortAlias(threadlinesName, badcodeName, legacyT3CodeName).pipe(
    Config.map((value) => Option.getOrElse(value, () => defaultValue)),
  );

const urlAliasWithDefault = (
  threadlinesName: string,
  badcodeName: string,
  legacyT3CodeName: string,
  defaultValue: string,
) =>
  firstSomeOption([
    Config.URL(threadlinesName).pipe(Config.option),
    Config.URL(badcodeName).pipe(Config.option),
    Config.URL(legacyT3CodeName).pipe(Config.option),
  ]).pipe(Config.map((value) => Option.getOrElse(value, () => new URL(defaultValue))));

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  desktopAppDataDirectory: trimmedStringAlias(
    "THREADLINES_DESKTOP_APP_DATA_DIR",
    "BADCODE_DESKTOP_APP_DATA_DIR",
    "T3CODE_DESKTOP_APP_DATA_DIR",
  ),
  desktopUserDataDirName: trimmedStringAlias(
    "THREADLINES_DESKTOP_USER_DATA_DIR_NAME",
    "BADCODE_DESKTOP_USER_DATA_DIR_NAME",
    "T3CODE_DESKTOP_USER_DATA_DIR_NAME",
  ),
  desktopBackendCwd: trimmedStringAlias(
    "THREADLINES_DESKTOP_BACKEND_CWD",
    "BADCODE_DESKTOP_BACKEND_CWD",
    "T3CODE_DESKTOP_BACKEND_CWD",
  ),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  // T3CODE_HOME is T3 Code's own live setting, not an old name of ours:
  // honoring it would point Threadlines at T3 Code's data folder.
  threadlinesHome: firstSomeOption([
    trimmedString("THREADLINES_HOME"),
    trimmedString("BADCODE_HOME"),
  ]),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  devRemoteThreadlinesServerEntryPath: firstSomeOption([
    trimmedString("THREADLINES_DEV_REMOTE_THREADLINES_SERVER_ENTRY_PATH"),
    trimmedString("BADCODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
    trimmedString("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  ]),
  configuredBackendPort: optionalPortAlias("THREADLINES_PORT", "BADCODE_PORT", "T3CODE_PORT"),
  commitHashOverride: trimmedStringAlias(
    "THREADLINES_COMMIT_HASH",
    "BADCODE_COMMIT_HASH",
    "T3CODE_COMMIT_HASH",
  ),
  desktopLanHostOverride: trimmedStringAlias(
    "THREADLINES_DESKTOP_LAN_HOST",
    "BADCODE_DESKTOP_LAN_HOST",
    "T3CODE_DESKTOP_LAN_HOST",
  ),
  desktopHttpsEndpointUrls: commaSeparatedStringsAlias(
    "THREADLINES_DESKTOP_HTTPS_ENDPOINTS",
    "BADCODE_DESKTOP_HTTPS_ENDPOINTS",
    "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
  ),
  relayUrl: urlAliasWithDefault(
    "THREADLINES_RELAY_URL",
    "BADCODE_RELAY_URL",
    "T3CODE_RELAY_URL",
    "https://threadlines-relay.threadlines.workers.dev",
  ),
  otlpTracesUrl: trimmedStringAlias(
    "THREADLINES_OTLP_TRACES_URL",
    "BADCODE_OTLP_TRACES_URL",
    "T3CODE_OTLP_TRACES_URL",
  ),
  otlpExportIntervalMs: intAliasWithDefault(
    "THREADLINES_OTLP_EXPORT_INTERVAL_MS",
    "BADCODE_OTLP_EXPORT_INTERVAL_MS",
    "T3CODE_OTLP_EXPORT_INTERVAL_MS",
    10_000,
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBooleanAlias(
    "THREADLINES_DISABLE_AUTO_UPDATE",
    "BADCODE_DISABLE_AUTO_UPDATE",
    "T3CODE_DISABLE_AUTO_UPDATE",
  ),
  openDevToolsInDevelopment: optionalBooleanAlias(
    "THREADLINES_DESKTOP_OPEN_DEVTOOLS",
    "BADCODE_DESKTOP_OPEN_DEVTOOLS",
    "T3CODE_DESKTOP_OPEN_DEVTOOLS",
  ),
  marketingCaptureMode: Config.Boolean("THREADLINES_DESKTOP_MARKETING_CAPTURE").pipe(
    Config.option,
    Config.map((value) => Option.getOrElse(value, () => false)),
  ),
  mockUpdates: optionalBooleanAlias(
    "THREADLINES_DESKTOP_MOCK_UPDATES",
    "BADCODE_DESKTOP_MOCK_UPDATES",
    "T3CODE_DESKTOP_MOCK_UPDATES",
  ),
  mockUpdateServerPort: portAliasWithDefault(
    "THREADLINES_DESKTOP_MOCK_UPDATE_SERVER_PORT",
    "BADCODE_DESKTOP_MOCK_UPDATE_SERVER_PORT",
    "T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT",
    3000,
  ),
  previewUpdateState: trimmedStringAlias(
    "THREADLINES_DESKTOP_PREVIEW_UPDATE_STATE",
    "BADCODE_DESKTOP_PREVIEW_UPDATE_STATE",
    "T3CODE_DESKTOP_PREVIEW_UPDATE_STATE",
  ),
  previewUpdateVersion: trimmedStringAlias(
    "THREADLINES_DESKTOP_PREVIEW_UPDATE_VERSION",
    "BADCODE_DESKTOP_PREVIEW_UPDATE_VERSION",
    "T3CODE_DESKTOP_PREVIEW_UPDATE_VERSION",
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
