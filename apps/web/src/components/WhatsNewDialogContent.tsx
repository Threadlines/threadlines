/**
 * The body of "What's new" (WhatsNewDialog.tsx): the notes for one release,
 * picked from a menu that starts on the version you have. A stable release
 * shows its reviewed notes (title, summary, video, highlights); a nightly
 * build shows the changes merged since the build you had before, build by
 * build, then the earlier nightlies back to the last stable release, read
 * from GitHub.
 */
import {
  parseNightlyVersion,
  RELEASE_NOTES_REPOSITORY,
  RELEASE_NOTES_SITE_URL,
  type ReleaseNotesEntry,
} from "@threadlines/shared/releaseNotes";
import { PlayIcon } from "lucide-react";
import { useState } from "react";
import releaseNotes from "virtual:release-notes";

import { APP_VERSION } from "../branding";
import { openExternalUrl } from "../lib/externalLinks";
import { readPreviousAppVersion, useNightlyBuilds } from "../lib/whatsNew";
import {
  describeBuild,
  describeNightlyLead,
  type NightlyBuildChanges,
  planNightlyList,
  releaseChangeTag,
  releaseNotesUpTo,
  splitNightlyBuilds,
} from "../lib/whatsNew.logic";
import { Button } from "./ui/button";
import { DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { closeWhatsNewDialog } from "./WhatsNewDialog";

const NIGHTLY_CHOICE = "nightly";

/** "Oct 28" for a day this year, "Oct 28, 2025" for an older one. */
function formatReleaseDay(day: string, withYear = false): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear || !sameYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
}

function releasePageUrl(version: string): string {
  return `https://github.com/${RELEASE_NOTES_REPOSITORY}/releases/tag/v${version}`;
}

export function WhatsNewDialogContent() {
  const nightly = parseNightlyVersion(APP_VERSION);
  const entries = releaseNotesUpTo(releaseNotes, APP_VERSION);
  const [choice, setChoice] = useState<string | null>(
    nightly ? NIGHTLY_CHOICE : (entries[0]?.version ?? null),
  );
  const entry = entries.find((candidate) => candidate.version === choice) ?? null;
  const choiceLabel = (value: string) =>
    value === NIGHTLY_CHOICE && nightly
      ? `Nightly ${nightly.build}`
      : `v${value}${(() => {
          const day = entries.find((candidate) => candidate.version === value)?.date;
          return day ? ` · ${formatReleaseDay(day)}` : "";
        })()}`;
  const githubUrl = entry?.githubRelease ?? releasePageUrl(APP_VERSION);

  return (
    <DialogPopup className="max-w-xl" data-testid="whats-new-dialog">
      <DialogHeader className="flex-row items-center gap-3 pe-12">
        <DialogTitle className="flex-1">What's new</DialogTitle>
        {choice !== null ? (
          <Select
            value={choice}
            onValueChange={(value) => {
              if (typeof value === "string") setChoice(value);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-0"
              aria-label="Release"
              data-testid="whats-new-release-picker"
            >
              <SelectValue>{choiceLabel(choice)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {nightly ? (
                <SelectItem value={NIGHTLY_CHOICE}>{choiceLabel(NIGHTLY_CHOICE)}</SelectItem>
              ) : null}
              {entries.map((candidate) => (
                <SelectItem key={candidate.version} value={candidate.version}>
                  {choiceLabel(candidate.version)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </DialogHeader>
      <DialogPanel>
        {entry ? (
          <ReleaseNotesView entry={entry} />
        ) : choice === NIGHTLY_CHOICE ? (
          <NightlyChangesView lastStableVersion={entries[0]?.version ?? null} />
        ) : (
          <p className="text-sm text-muted-foreground">This build has no release notes.</p>
        )}
      </DialogPanel>
      <DialogFooter className="sm:justify-between">
        <Button variant="link" className="px-0" onClick={() => openExternalUrl(githubUrl)}>
          Every change on GitHub
        </Button>
        <Button onClick={closeWhatsNewDialog}>Done</Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function ReleaseNotesView({ entry }: { readonly entry: ReleaseNotesEntry }) {
  return (
    <article className="grid gap-4" data-testid="whats-new-release" data-version={entry.version}>
      <div className="grid gap-1">
        <h3 className="font-semibold text-[15px] leading-snug">{entry.title}</h3>
        <p className="font-mono text-[11px] text-muted-foreground">
          v{entry.version} · {formatReleaseDay(entry.date, true)}
        </p>
        <p className="text-[13px] text-muted-foreground">{entry.summary}</p>
      </div>
      {entry.video ? <ReleaseVideo key={entry.version} video={entry.video} /> : null}
      <div className="grid gap-3">
        {entry.highlights.map((highlight) => (
          <section key={highlight.title} className="grid gap-0.5">
            <h4 className="font-semibold text-[13.5px]">{highlight.title}</h4>
            <p className="text-[13px] text-muted-foreground">{highlight.description}</p>
          </section>
        ))}
      </div>
      {entry.alsoImproved.length > 0 ? (
        <section className="grid gap-1.5">
          <h4 className="font-semibold text-muted-foreground text-xs">Also improved</h4>
          <ul className="grid list-disc gap-1 ps-4 text-[13px] text-muted-foreground">
            {entry.alsoImproved.map((improvement) => (
              <li key={improvement.description}>{improvement.description}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

/**
 * A release's video from the marketing site: its poster with a play button
 * until clicked, then the video itself. Offline, the poster doesn't load and
 * the whole block steps aside.
 */
function ReleaseVideo({ video }: { readonly video: NonNullable<ReleaseNotesEntry["video"]> }) {
  const [state, setState] = useState<"poster" | "playing" | "unavailable">("poster");
  if (state === "unavailable") return null;
  const poster = new URL(video.poster, RELEASE_NOTES_SITE_URL).href;
  return (
    <figure className="grid gap-1.5">
      <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
        {state === "playing" ? (
          <video
            className="size-full"
            controls
            autoPlay
            poster={poster}
            src={new URL(video.src, RELEASE_NOTES_SITE_URL).href}
            onError={() => setState("unavailable")}
          />
        ) : (
          <button
            type="button"
            className="group/video size-full cursor-pointer focus-ring"
            aria-label="Play the video"
            onClick={() => setState("playing")}
          >
            <img
              alt=""
              className="size-full object-cover"
              src={poster}
              onError={() => setState("unavailable")}
            />
            <span className="absolute inset-0 m-auto grid size-11 place-items-center rounded-full bg-black/55 text-white transition-colors group-hover/video:bg-black/70">
              <PlayIcon className="ms-0.5 size-4.5 fill-current" />
            </span>
          </button>
        )}
      </div>
      <figcaption className="text-muted-foreground text-xs">{video.caption}</figcaption>
    </figure>
  );
}

/**
 * A nightly's list: the builds since the one this device ran before, then the
 * earlier nightlies back to the last stable release, read from GitHub.
 */
function NightlyChangesView({ lastStableVersion }: { readonly lastStableVersion: string | null }) {
  const { since, range } = planNightlyList({
    appVersion: APP_VERSION,
    previousVersion: readPreviousAppVersion(),
    lastStableVersion,
  });
  const query = useNightlyBuilds(range);

  if (query.isPending) {
    return <p className="text-sm text-muted-foreground">Reading the changes from GitHub…</p>;
  }
  if (query.isError) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="whats-new-nightly-error">
        GitHub didn't answer, so the changes can't show here. They're on GitHub.
      </p>
    );
  }
  const { builds, complete } = query.data;
  const { fresh, earlier } = splitNightlyBuilds(builds, since, APP_VERSION);
  // Any earlier build means the list reached back past the one you had.
  const freshComplete = complete || since === null || earlier.length > 0;
  const earlierWithChanges = earlier.filter((build) => build.changes.length > 0);

  return (
    <div className="grid gap-3" data-testid="whats-new-nightly">
      <p className="text-[13px] text-muted-foreground">
        {describeNightlyLead({ fresh, since, freshComplete, appVersion: APP_VERSION })}
      </p>
      {fresh
        .filter((build) => build.changes.length > 0)
        .map((build) => (
          <NightlyBuildSection key={build.version} build={build} />
        ))}
      {earlierWithChanges.length > 0 ? (
        <section className="grid gap-3 border-t pt-3" data-testid="whats-new-nightly-earlier">
          <h3 className="font-semibold text-muted-foreground text-xs">
            {range.after === null
              ? "Earlier builds"
              : `Earlier builds since ${describeBuild(range.after)}`}
          </h3>
          {earlierWithChanges.map((build) => (
            <NightlyBuildSection key={build.version} build={build} />
          ))}
        </section>
      ) : null}
      {!complete && freshComplete ? (
        <p className="text-muted-foreground text-xs">Older builds are on GitHub.</p>
      ) : null}
    </div>
  );
}

function NightlyBuildSection({ build }: { readonly build: NightlyBuildChanges }) {
  const day = build.publishedAt?.slice(0, 10);
  return (
    <section className="grid gap-1">
      <h4 className="font-mono text-[11px] text-muted-foreground">
        Build {build.build}
        {day ? ` · ${formatReleaseDay(day)}` : ""}
      </h4>
      <ul className="grid gap-1">
        {build.changes.map((change) => {
          const tag = releaseChangeTag(change.kind);
          return (
            <li
              key={`${change.pullRequest ?? ""}:${change.text}`}
              className="flex items-baseline gap-2 text-[13px]"
            >
              <span
                className={
                  tag === "New"
                    ? "w-13 shrink-0 rounded-[4px] bg-primary-readable/14 text-center font-mono text-[10.5px] text-primary-readable leading-4"
                    : "w-13 shrink-0 rounded-[4px] bg-foreground/8 text-center font-mono text-[10.5px] text-muted-foreground leading-4"
                }
              >
                {tag}
              </span>
              <span className="min-w-0">{change.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
