import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const preferredOption = <A>(
  preferred: Config.Config<Option.Option<A>>,
  legacy: Config.Config<Option.Option<A>>,
) =>
  Config.all({ preferred, legacy }).pipe(
    Config.map(({ preferred, legacy }) => (Option.isSome(preferred) ? preferred : legacy)),
  );

const trimmedStringAlias = (preferredName: string, legacyName: string) =>
  preferredOption(trimmedString(preferredName), trimmedString(legacyName));

const optionalBooleanAlias = (preferredName: string, legacyName: string) =>
  Config.all({
    preferred: Config.boolean(preferredName).pipe(Config.option),
    legacy: Config.boolean(legacyName).pipe(Config.option),
  }).pipe(
    Config.map(({ preferred, legacy }) =>
      Option.getOrElse(Option.isSome(preferred) ? preferred : legacy, () => false),
    ),
  );

const optionalPortAlias = (preferredName: string, legacyName: string) =>
  Config.all({
    preferred: Config.port(preferredName).pipe(Config.option),
    legacy: Config.port(legacyName).pipe(Config.option),
  }).pipe(Config.map(({ preferred, legacy }) => (Option.isSome(preferred) ? preferred : legacy)));

const intAliasWithDefault = (preferredName: string, legacyName: string, defaultValue: number) =>
  Config.all({
    preferred: Config.int(preferredName).pipe(Config.option),
    legacy: Config.int(legacyName).pipe(Config.option),
  }).pipe(
    Config.map(({ preferred, legacy }) =>
      Option.getOrElse(Option.isSome(preferred) ? preferred : legacy, () => defaultValue),
    ),
  );

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

const commaSeparatedStringsAlias = (preferredName: string, legacyName: string) =>
  preferredOption(
    commaSeparatedStringsOption(preferredName),
    commaSeparatedStringsOption(legacyName),
  ).pipe(Config.map(Option.getOrElse(() => [])));

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  t3Home: trimmedStringAlias("BADCODE_HOME", "T3CODE_HOME"),
  devServerUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  devRemoteT3ServerEntryPath: trimmedStringAlias(
    "BADCODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH",
    "T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH",
  ),
  configuredBackendPort: optionalPortAlias("BADCODE_PORT", "T3CODE_PORT"),
  commitHashOverride: trimmedStringAlias("BADCODE_COMMIT_HASH", "T3CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedStringAlias("BADCODE_DESKTOP_LAN_HOST", "T3CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStringsAlias(
    "BADCODE_DESKTOP_HTTPS_ENDPOINTS",
    "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
  ),
  otlpTracesUrl: trimmedStringAlias("BADCODE_OTLP_TRACES_URL", "T3CODE_OTLP_TRACES_URL"),
  otlpExportIntervalMs: intAliasWithDefault(
    "BADCODE_OTLP_EXPORT_INTERVAL_MS",
    "T3CODE_OTLP_EXPORT_INTERVAL_MS",
    10_000,
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBooleanAlias(
    "BADCODE_DISABLE_AUTO_UPDATE",
    "T3CODE_DISABLE_AUTO_UPDATE",
  ),
  openDevToolsInDevelopment: optionalBooleanAlias(
    "BADCODE_DESKTOP_OPEN_DEVTOOLS",
    "T3CODE_DESKTOP_OPEN_DEVTOOLS",
  ),
  mockUpdates: optionalBooleanAlias("BADCODE_DESKTOP_MOCK_UPDATES", "T3CODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.all({
    preferred: Config.port("BADCODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
    legacy: Config.port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
  }).pipe(
    Config.map(({ preferred, legacy }) =>
      Option.getOrElse(Option.isSome(preferred) ? preferred : legacy, () => 3000),
    ),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
