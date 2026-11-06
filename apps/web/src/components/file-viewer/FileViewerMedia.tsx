/**
 * A video or sound file in the file viewer: fetched in pieces (see
 * lib/mediaPlayback.ts), then played by the browser's own player. A file up
 * to 64 MB starts loading as it opens; a bigger one waits for Load, since on
 * a phone that can be a long download. Once a video shows its first frame,
 * that frame becomes the video's poster in the Media tab.
 */
import type { EnvironmentId } from "@threadlines/contracts";
import { FileAudioIcon, FileVideoIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import {
  loadMediaFile,
  MEDIA_AUTOLOAD_MAX_BYTES,
  MEDIA_PLAY_MAX_BYTES,
} from "../../lib/mediaPlayback";
import { resolvePathLinkTarget } from "../../terminal-links";
import { primeMediaThumbnail, videoPosterKey } from "../media/mediaThumbnails";
import { Button } from "../ui/button";

/** Wide enough for a sharp poster in a two-column tile on a 2x screen. */
const POSTER_WIDTH = 400;

type PlayerState =
  | { readonly phase: "waiting" }
  | { readonly phase: "loading"; readonly loaded: number }
  | { readonly phase: "ready"; readonly url: string; readonly version: string }
  | { readonly phase: "failed"; readonly reason: "missing" | "error" | "unplayable" };

function basename(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

/** Resolves on `event`, or false after `timeoutMs` or on an error. */
function waitFor(target: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
      resolve(ok);
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

/**
 * A frame from a little way in (the very first is often black), shrunk, for
 * the video's poster. Taken from a hidden copy of the video, so the player on
 * screen is never moved, and checked for being blank: a browser can hand back
 * an empty frame, and an empty poster is worse than none. Null when there is
 * no frame worth keeping.
 */
async function capturePoster(url: string): Promise<Blob | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    if (!(await waitFor(video, "loadeddata", 5_000))) {
      return null;
    }
    const at =
      Number.isFinite(video.duration) && video.duration > 0 ? Math.min(1, video.duration / 4) : 0;
    video.currentTime = at;
    if (!(await waitFor(video, "seeked", 5_000)) || video.videoWidth === 0) {
      return null;
    }
    const scale = Math.min(1, POSTER_WIDTH / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Sample a few rows: an undrawn frame is fully transparent.
    const sample = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = false;
    for (let index = 3; index < sample.length; index += 4 * 97) {
      if (sample[index] !== 0) {
        opaque = true;
        break;
      }
    }
    if (!opaque) {
      return null;
    }
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export function FileViewerMedia(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly size: number;
  readonly mediaKind: "video" | "audio";
  /** Reveal and Copy path, for a file this player can't play. */
  readonly fallbackActions: ReactNode;
}) {
  const { environmentId, cwd, path, size, mediaKind, fallbackActions } = props;
  const tooBig = size > MEDIA_PLAY_MAX_BYTES;
  const [requested, setRequested] = useState(size <= MEDIA_AUTOLOAD_MAX_BYTES);
  const [state, setState] = useState<{ readonly key: string; readonly value: PlayerState }>({
    key: "",
    value: { phase: "waiting" },
  });
  const fileKey = `${environmentId}|${cwd}|${path}|${size}`;
  const current = state.key === fileKey ? state.value : null;
  const capturedRef = useRef(false);

  useEffect(() => {
    if (!requested || tooBig) {
      return;
    }
    const controller = new AbortController();
    let url: string | null = null;
    capturedRef.current = false;
    const update = (value: PlayerState) => {
      if (!controller.signal.aborted) {
        setState({ key: fileKey, value });
      }
    };
    void loadMediaFile({
      environmentId,
      cwd,
      relativePath: path,
      signal: controller.signal,
      onProgress: (loaded) => update({ phase: "loading", loaded }),
    }).then(
      (result) => {
        if (controller.signal.aborted) {
          return;
        }
        if (result.kind === "loaded") {
          url = URL.createObjectURL(result.blob);
          update({ phase: "ready", url, version: result.version });
          return;
        }
        update({ phase: "failed", reason: result.kind === "missing" ? "missing" : "error" });
      },
      () => update({ phase: "failed", reason: "error" }),
    );
    return () => {
      controller.abort();
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [cwd, environmentId, fileKey, path, requested, tooBig]);

  const name = basename(path);
  const Icon = mediaKind === "video" ? FileVideoIcon : FileAudioIcon;
  const notice = (children: ReactNode) => (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      <Icon aria-hidden className="size-5" />
      {children}
    </div>
  );

  if (tooBig) {
    return notice(
      <>
        <p>
          {name} is too big to play here ({formatBytes(size)}).
        </p>
        <div className="flex items-center gap-2">{fallbackActions}</div>
      </>,
    );
  }
  if (!requested) {
    return notice(
      <>
        <p>
          {name} · {formatBytes(size)}
        </p>
        <Button size="sm" variant="outline" onClick={() => setRequested(true)}>
          {mediaKind === "video" ? "Load video" : "Load audio"}
        </Button>
      </>,
    );
  }
  if (current?.phase === "failed") {
    return notice(
      <>
        <p>
          {current.reason === "missing"
            ? `${name} is no longer on disk.`
            : current.reason === "unplayable"
              ? `This browser can't play ${name}.`
              : `Couldn't load ${name}.`}
        </p>
        <div className="flex items-center gap-2">{fallbackActions}</div>
      </>,
    );
  }
  if (current?.phase !== "ready") {
    const loaded = current?.phase === "loading" ? current.loaded : 0;
    const percent = size > 0 ? Math.round((loaded / size) * 100) : 0;
    return notice(
      <>
        <p>
          Loading {name} · {formatBytes(loaded)} of {formatBytes(size)}
        </p>
        <div
          className="h-1 w-48 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`Loading ${name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      </>,
    );
  }

  const markUnplayable = () =>
    setState({ key: fileKey, value: { phase: "failed", reason: "unplayable" } });
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4">
      {mediaKind === "video" ? (
        <video
          key={current.url}
          src={current.url}
          controls
          playsInline
          aria-label={name}
          className="max-h-full max-w-full rounded-md bg-black"
          onError={markUnplayable}
          onLoadedData={() => {
            if (capturedRef.current) {
              return;
            }
            capturedRef.current = true;
            void capturePoster(current.url).then((blob) => {
              if (blob) {
                primeMediaThumbnail(
                  videoPosterKey(environmentId, resolvePathLinkTarget(path, cwd), current.version),
                  { blob, size },
                );
              }
            });
          }}
        />
      ) : (
        <>
          <Icon aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{name}</p>
          <audio
            key={current.url}
            src={current.url}
            controls
            aria-label={name}
            className="w-full max-w-md"
            onError={markUnplayable}
          />
        </>
      )}
    </div>
  );
}
