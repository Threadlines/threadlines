import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
const WINDOWS_SCREEN_CLIP_URI = "ms-screenclip:";

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export interface ElectronShellShape {
  readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
  readonly openScreenClip: () => Effect.Effect<boolean>;
  readonly copyText: (text: string) => Effect.Effect<void>;
}

export class ElectronShell extends Context.Service<ElectronShell, ElectronShellShape>()(
  "t3/desktop/electron/Shell",
) {}

const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  openScreenClip: () =>
    Effect.promise(() =>
      Electron.shell.openExternal(WINDOWS_SCREEN_CLIP_URI).then(
        () => true,
        () => false,
      ),
    ),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
