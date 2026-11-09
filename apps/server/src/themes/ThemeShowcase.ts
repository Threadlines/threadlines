// @effect-diagnostics nodeBuiltinImport:off - Brotli for reading a font's notice, and the home folder `gh` runs in
/**
 * The Showcase (docs/design/custom-themes.md, "Showcase"): themes people
 * shared, in the public Threadlines/themes repository.
 *
 * Reading it: the list (`index.json`) and every file it points to come from
 * the repository's main branch on raw.githubusercontent.com and nowhere else,
 * with no redirects followed. Each file must match the size and SHA-256 the
 * list gives it, and a theme its content hash, before the app sees it. The
 * list is kept for half an hour, and kept when a later fetch fails.
 *
 * Sharing to it: from the person's own GitHub account (the one `gh` uses on
 * this computer), as a pull request from their fork. Each share has an id the
 * app mints; its branch is named by it, so every step can be taken again:
 * sending the same share twice updates one branch and finds one pull request
 * instead of opening another. Before posting anything, the service checks
 * the account is still the one the person saw.
 */
import * as NodeOS from "node:os";
import { brotliDecompressSync, inflateSync } from "node:zlib";

import {
  THEME_MAX_FILE_BYTES,
  THEME_SHOWCASE_FORMAT,
  type ThemeManifest,
  ThemeShowcaseEntry,
  ThemeShowcaseError,
  type ThemeShowcaseFont,
  type ThemeShowcaseIdInput,
  type ThemeShowcaseListInput,
  type ThemeShowcaseListing,
  type ThemeShowcasePicture,
  type ThemeShowcasePreparation,
  type ThemeShowcaseShareInput,
  type ThemeShowcaseSubmission,
  type ThemeShowcaseSubmissions,
  type ThemeShowcaseSubmitInput,
  type ThemeShowcaseTheme,
} from "@threadlines/contracts";
import {
  fontNoticeLicense,
  readWoff2Notice,
  WOFF2_MAX_DECOMPRESSED_BYTES,
} from "@threadlines/shared/themeFontNotice";
import { checkThemeManifest, themeContentHash } from "@threadlines/shared/themeManifest";
import { themeFileText, themeForSharing } from "@threadlines/shared/themeSharing";
import {
  plainPng,
  pngDataUrlBytes,
  sha256Hex,
  showcaseFontProblems,
  showcasePngProblems,
  showcaseSlugFor,
  THEME_SHOWCASE_RAW_BASE,
  THEME_SHOWCASE_REPOSITORY,
  THEME_SHOWCASE_THUMBNAIL,
  themeShowcaseProblems,
} from "@threadlines/shared/themeShowcase";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { makeHttpsFetch } from "../provider/managedRuntime/HttpsFetch.ts";
import type { DownloadFetch } from "../provider/managedRuntime/VerifiedDownload.ts";
import {
  GitHubCli,
  type GitHubCliError,
  gitHubFailureKind,
  gitHubHttpStatus,
} from "../sourceControl/GitHubCli.ts";
import { themeAnalyticsProperties } from "../telemetry/AnalyticsProperties.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { ThemeLibraryRepository } from "./ThemeLibraryRepository.ts";
import { readCapped } from "./themeFonts.ts";
import {
  ThemeShowcaseRepository,
  type ThemeShowcaseSubmissionRow,
} from "./ThemeShowcaseRepository.ts";
import { ThemeWorkshop } from "./ThemeWorkshop.ts";

/** How long a fetched list is fresh. */
const LIST_FRESH_MS = 30 * 60_000;
/** After a failed fetch, how long the list isn't fetched again unless asked (Try again). */
const LIST_RETRY_MS = 30_000;
const LIST_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
/** Pictures kept in memory, by digest. */
const PICTURES_KEPT = 120;
/** A share's pull request state is looked up again at most this often. */
const STATE_CHECK_MS = 5 * 60_000;
const GITHUB_HOST = "github.com";
const LOOKUP_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 60_000;
/** How long to wait for a new fork to answer, in tries 2 seconds apart. */
const FORK_READY_TRIES = 15;

export interface ThemeShowcaseShape {
  /** The list as last fetched, fetched again when old or asked to. Never fails. */
  readonly list: (input: ThemeShowcaseListInput) => Effect.Effect<ThemeShowcaseListing>;
  readonly picture: (
    input: ThemeShowcaseIdInput,
  ) => Effect.Effect<ThemeShowcasePicture, ThemeShowcaseError>;
  /** A theme from the list, checked against it, to try. */
  readonly read: (
    input: ThemeShowcaseIdInput,
  ) => Effect.Effect<ThemeShowcaseTheme, ThemeShowcaseError>;
  /** What sharing a library theme would publish, and why it can't be yet. */
  readonly prepare: (
    input: ThemeShowcaseShareInput,
  ) => Effect.Effect<ThemeShowcasePreparation, ThemeShowcaseError>;
  /** Shares a library theme as a pull request from the person's GitHub account. */
  readonly submit: (
    input: ThemeShowcaseSubmitInput,
  ) => Effect.Effect<ThemeShowcaseSubmission, ThemeShowcaseError>;
  /** This computer's shares, their states looked up again when old. */
  readonly submissions: Effect.Effect<ThemeShowcaseSubmissions, ThemeShowcaseError>;
  /** Whether a theme with this content is in the list as last fetched. */
  readonly listed: (hash: string) => Effect.Effect<boolean>;
}

export class ThemeShowcase extends Context.Service<ThemeShowcase, ThemeShowcaseShape>()(
  "threadlines/themes/ThemeShowcase",
) {}

const showcaseError = (detail: string, uncertain = false) =>
  new ThemeShowcaseError({ detail, ...(uncertain ? { uncertain } : {}) });

const REASONS = {
  noGitHubCli:
    "Sharing needs the GitHub command-line tool (gh) on this computer. Install it and sign in, then share again.",
  signedOut: "This computer isn't signed in to GitHub. Sign in, then share again.",
  rateLimited: "GitHub is limiting requests right now. Try again in a few minutes.",
  rejected: "GitHub didn't accept the share.",
  unreachable: "Couldn't reach GitHub. Check your connection and try again.",
  uncertain:
    "GitHub didn't answer in time, so the pull request may have opened anyway. Sharing again checks for it first.",
} as const;

const reasonFor = (error: GitHubCliError) => {
  const kind = gitHubFailureKind(error);
  return kind === "unknown" ? REASONS.unreachable : REASONS[kind];
};

const decodeIndexHead = Schema.decodeUnknownOption(
  Schema.Struct({ format: Schema.String, themes: Schema.Array(Schema.Unknown) }),
);
const decodeEntry = Schema.decodeUnknownOption(ThemeShowcaseEntry);
const decodeFork = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, owner: Schema.String })),
);
const PullRequestLink = Schema.Struct({ number: Schema.Int, url: Schema.String });
const decodePullRequests = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(PullRequestLink)),
);
const decodePullRequest = Schema.decodeUnknownOption(Schema.fromJsonString(PullRequestLink));
const decodePullState = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ state: Schema.String, merged: Schema.Boolean })),
);

/** The list's entries that point where the format says they must; the rest are dropped. */
function entriesOf(themes: ReadonlyArray<unknown>): ThemeShowcaseEntry[] {
  const seen = new Set<string>();
  const entries: ThemeShowcaseEntry[] = [];
  for (const raw of themes) {
    const entry = Option.getOrUndefined(decodeEntry(raw));
    if (entry === undefined || seen.has(entry.id)) continue;
    if (entry.file.path !== `themes/${entry.id}/theme.threadlines-theme`) continue;
    if (entry.thumbnail.path !== `themes/${entry.id}/thumbnail.png`) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

/** A picture's image data unpacked, bounded well past what 320×200 can need. */
const inflatePicture = (data: Uint8Array) =>
  inflateSync(data, { maxOutputLength: 4 * 1024 * 1024 });

const pngDataUrl = (bytes: Uint8Array) =>
  `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

/** An embedded font's notice, read from the font itself. */
function fontsOf(manifest: ThemeManifest): ThemeShowcaseFont[] {
  const fonts: ThemeShowcaseFont[] = [];
  for (const slot of ["ui", "mono"] as const) {
    const font = manifest.fonts?.[slot];
    if (font?.data === undefined) continue;
    const read = readWoff2Notice(Buffer.from(font.data, "base64"), (data) =>
      brotliDecompressSync(data, { maxOutputLength: WOFF2_MAX_DECOMPRESSED_BYTES }),
    );
    fonts.push({
      slot,
      family: font.family,
      copyright: read.ok ? read.notice.copyright : null,
      license: read.ok ? fontNoticeLicense(read.notice) : null,
    });
  }
  return fonts;
}

const toSubmission = (row: ThemeShowcaseSubmissionRow): ThemeShowcaseSubmission | null =>
  row.pullRequestUrl === null
    ? null
    : {
        submissionId: row.submissionId,
        entryId: row.entryId,
        sourceHash: row.sourceHash,
        publishedHash: row.publishedHash,
        login: row.login,
        pullRequestUrl: row.pullRequestUrl,
        state: row.state,
        createdAt: row.createdAt,
      };

/** The pull request's text, with the repository's checklist filled in (the app's share is how it's agreed to). */
function pullRequestBody(input: {
  readonly manifest: ThemeManifest;
  readonly fonts: ReadonlyArray<ThemeShowcaseFont>;
  readonly submissionId: string;
}): string {
  const { manifest, fonts } = input;
  const credits = manifest.credits;
  const lines = [
    `Adds **${manifest.name}** to the Showcase, shared from Threadlines.`,
    "",
    `- License: ${credits?.license ?? "none"}`,
    `- Credit: ${[credits?.author, credits?.link].filter(Boolean).join(", ") || "none"}`,
    `- ${manifest.base === "dark" ? "Dark" : "Light"}, ${manifest.backdrop === undefined ? "no art" : `${manifest.backdrop.mode} art`}`,
    ...(fonts.length > 0
      ? [
          `- Fonts: ${fonts.map((font) => `${font.family} (${font.license ?? "unknown"})`).join(", ")}`,
        ]
      : []),
    `- Prompt included: ${manifest.prompt === undefined ? "no" : "yes"}`,
    "",
    "- [x] I made this theme, or I have the right to share it.",
    "- [x] Nothing in it is copied from a game, film or brand.",
    "- [x] Any embedded fonts are OFL 1.1 or Apache 2.0.",
    "- [x] I understand everything here is public, including my credit and the prompt if I included it.",
    "",
    `<!-- threadlines-showcase:${input.submissionId} -->`,
  ];
  return lines.join("\n");
}

/** Builds the Showcase on a given fetch; `layer` uses the real one. */
export const makeThemeShowcase = Effect.fn("ThemeShowcase.make")(function* (
  options: { readonly fetch?: DownloadFetch; readonly now?: () => number } = {},
) {
  const library = yield* ThemeLibraryRepository;
  const workshop = yield* ThemeWorkshop;
  const submissionsRepo = yield* ThemeShowcaseRepository;
  const github = yield* GitHubCli;
  const analytics = yield* AnalyticsService;
  const fetch =
    options.fetch ??
    makeHttpsFetch({
      allowedHosts: [new URL(THEME_SHOWCASE_RAW_BASE).hostname],
      publicAddressesOnly: true,
      maxRedirects: 0,
    });
  const now = options.now ?? Date.now;
  const listLock = yield* Semaphore.make(1);
  const shareLock = yield* Semaphore.make(1);
  const cwd = NodeOS.homedir();

  let cached: {
    readonly entries: ReadonlyArray<ThemeShowcaseEntry>;
    readonly fetchedAt: number;
  } | null = null;
  let lastFailure: { readonly at: number; readonly issue: "unreachable" | "updateNeeded" } | null =
    null;
  const pictures = new Map<string, string>();
  /**
   * The pictures the share dialog showed, by the library theme's content (a
   * credit or the prompt doesn't change how it looks), so the share sends the
   * same one and changing a credit doesn't draw it again.
   */
  const preparedPictures = new Map<string, Uint8Array>();

  // ---- Reading -----------------------------------------------------------

  /** One file from the repository's main branch, at most `maxBytes`. */
  const fetchFile = (path: string, maxBytes: number) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${THEME_SHOWCASE_RAW_BASE}${path}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`GitHub answered ${response.status} for ${path}`);
        }
        const bytes = await readCapped(response, maxBytes);
        if (bytes === null) throw new Error(`${path} is larger than ${maxBytes} bytes`);
        return bytes;
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    });

  const listing = (issue: "unreachable" | "updateNeeded" | null): ThemeShowcaseListing => ({
    themes: cached?.entries ?? [],
    fetchedAt: cached === null ? null : new Date(cached.fetchedAt).toISOString(),
    issue,
  });

  const fetchList = Effect.gen(function* () {
    const bytes = yield* fetchFile("index.json", LIST_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return yield* Effect.fail("index.json isn't JSON");
    }
    const head = Option.getOrUndefined(decodeIndexHead(parsed));
    if (head === undefined) return yield* Effect.fail("index.json isn't a Showcase list");
    if (head.format !== THEME_SHOWCASE_FORMAT) return "updateNeeded" as const;
    cached = { entries: entriesOf(head.themes), fetchedAt: now() };
    lastFailure = null;
    return null;
  });

  const list: ThemeShowcaseShape["list"] = (input) =>
    listLock.withPermits(1)(
      Effect.gen(function* () {
        const at = now();
        const fresh = cached !== null && at - cached.fetchedAt < LIST_FRESH_MS;
        if (input.refresh !== true) {
          // A fetch that failed since the last good one still marks the list as old.
          if (fresh && lastFailure === null) return listing(null);
          if (lastFailure !== null && at - lastFailure.at < LIST_RETRY_MS) {
            return listing(lastFailure.issue);
          }
        }
        const outcome = yield* fetchList.pipe(Effect.result);
        if (outcome._tag === "Success" && outcome.success === null) return listing(null);
        const issue =
          outcome._tag === "Success" ? (outcome.success ?? "unreachable") : "unreachable";
        if (outcome._tag === "Failure") {
          yield* Effect.logInfo("The Showcase list couldn't be fetched.", {
            reason: outcome.failure,
          });
        }
        lastFailure = { at, issue };
        return listing(issue);
      }),
    );

  const entryFor = (id: string) =>
    Effect.gen(function* () {
      const entry = (cached?.entries ?? []).find((candidate) => candidate.id === id);
      if (entry !== undefined) return entry;
      const fetched = yield* list({});
      const found = fetched.themes.find((candidate) => candidate.id === id);
      if (found !== undefined) return found;
      return yield* showcaseError(
        fetched.issue === null
          ? "That theme isn't in the Showcase anymore."
          : "Couldn't reach the Showcase. Check your connection and try again.",
      );
    });

  /** A file the list points to, checked against its size and digest. */
  const fetchAsset = (asset: ThemeShowcaseEntry["file"], maxBytes: number) =>
    Effect.gen(function* () {
      const bytes = yield* fetchFile(asset.path, Math.min(asset.bytes, maxBytes)).pipe(
        Effect.mapError(() =>
          showcaseError("Couldn't reach the Showcase. Check your connection and try again."),
        ),
      );
      const digest = yield* Effect.promise(() => sha256Hex(bytes));
      if (bytes.length !== asset.bytes || digest !== asset.sha256) {
        return yield* showcaseError(
          "The Showcase sent a file that doesn't match its list, so Threadlines didn't use it.",
        );
      }
      return bytes;
    });

  const picture: ThemeShowcaseShape["picture"] = (input) =>
    Effect.gen(function* () {
      const entry = yield* entryFor(input.id);
      const kept = pictures.get(entry.thumbnail.sha256);
      if (kept !== undefined) return { dataUrl: kept };
      const bytes = yield* fetchAsset(entry.thumbnail, THEME_SHOWCASE_THUMBNAIL.maxBytes);
      if (showcasePngProblems(bytes, THEME_SHOWCASE_THUMBNAIL, inflatePicture).length > 0) {
        return yield* showcaseError("The theme's picture isn't a plain PNG.");
      }
      const dataUrl = pngDataUrl(bytes);
      pictures.set(entry.thumbnail.sha256, dataUrl);
      if (pictures.size > PICTURES_KEPT) {
        const oldest = pictures.keys().next().value;
        if (oldest !== undefined) pictures.delete(oldest);
      }
      return { dataUrl };
    });

  const read: ThemeShowcaseShape["read"] = (input) =>
    Effect.gen(function* () {
      const entry = yield* entryFor(input.id);
      const bytes = yield* fetchAsset(entry.file, THEME_MAX_FILE_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return yield* showcaseError("The theme's file isn't a theme.");
      }
      const check = checkThemeManifest(parsed);
      if (!check.ok)
        return yield* showcaseError("The theme's file isn't a theme Threadlines can use.");
      const hash = yield* Effect.promise(() => themeContentHash(check.manifest));
      if (hash !== entry.hash) {
        return yield* showcaseError(
          "The Showcase sent a file that doesn't match its list, so Threadlines didn't use it.",
        );
      }
      yield* analytics.record("theme.showcase.tried", {
        ...themeAnalyticsProperties(check.manifest),
        origin: "showcase",
        featured: entry.featured,
      });
      return { id: entry.id, hash, manifest: check.manifest };
    });

  const listed: ThemeShowcaseShape["listed"] = (hash) =>
    Effect.sync(() => (cached?.entries ?? []).some((entry) => entry.hash === hash));

  // ---- Sharing -----------------------------------------------------------

  /** The library theme a share starts from, made ready to publish, and why it can't be yet. */
  const buildShare = (input: ThemeShowcaseShareInput) =>
    Effect.gen(function* () {
      const stored = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError(() => showcaseError("Threadlines couldn't read the theme library.")),
        );
      const entry = Option.getOrUndefined(yield* stored(library.getEntry(input.entryId)));
      const content =
        entry === undefined || entry.deleted
          ? undefined
          : Option.getOrUndefined(yield* stored(library.getContent(entry.hash)));
      if (entry === undefined || content === undefined) {
        return yield* showcaseError("That theme isn't in this computer's library.");
      }
      const manifest = themeForSharing(content.manifest, {
        name: entry.name,
        includePrompt: input.includePrompt,
        credits: input.credits,
      });
      const hash = yield* Effect.promise(() => themeContentHash(manifest));
      const fonts = fontsOf(manifest);
      const problems = [...themeShowcaseProblems(manifest), ...showcaseFontProblems(fonts)];
      if (new TextEncoder().encode(themeFileText(manifest)).length > THEME_MAX_FILE_BYTES) {
        problems.push("It's larger than a theme file may be.");
      }

      let pictureBytes = preparedPictures.get(content.hash) ?? null;
      if (pictureBytes === null) {
        const drawn = yield* workshop.picture(manifest).pipe(Effect.result);
        if (drawn._tag === "Failure") {
          problems.push(drawn.failure.detail);
        } else {
          const raw = pngDataUrlBytes(drawn.success);
          const plain = raw === null ? null : plainPng(raw);
          const pictureProblems =
            plain === null
              ? ["Couldn't draw the theme's picture."]
              : showcasePngProblems(plain, THEME_SHOWCASE_THUMBNAIL, inflatePicture);
          if (plain !== null && pictureProblems.length === 0) {
            pictureBytes = plain;
            preparedPictures.set(content.hash, plain);
            if (preparedPictures.size > 4) {
              const oldest = preparedPictures.keys().next().value;
              if (oldest !== undefined) preparedPictures.delete(oldest);
            }
          } else {
            problems.push(...pictureProblems);
          }
        }
      }
      return { entry, sourceHash: content.hash, manifest, hash, fonts, pictureBytes, problems };
    });

  const prepare: ThemeShowcaseShape["prepare"] = (input) =>
    buildShare(input).pipe(
      Effect.map((share) => ({
        manifest: share.manifest,
        thumbnail: share.pictureBytes === null ? null : pngDataUrl(share.pictureBytes),
        fonts: share.fonts,
        problems: share.problems,
      })),
    );

  const gh = (
    args: ReadonlyArray<string>,
    options: { readonly timeoutMs?: number; readonly body?: unknown } = {},
  ) =>
    github
      .execute({
        cwd,
        args: [
          "api",
          "--hostname",
          GITHUB_HOST,
          ...(options.body === undefined ? [] : ["--input", "-"]),
          ...args,
        ],
        timeoutMs: options.timeoutMs ?? LOOKUP_TIMEOUT_MS,
        ...(options.body === undefined ? {} : { stdin: JSON.stringify(options.body) }),
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

  /** A `gh` answer that must be there; a missing one fails like a dropped connection. */
  const nonEmpty = (text: string) =>
    text.length > 0 ? Effect.succeed(text) : Effect.fail(showcaseError(REASONS.unreachable));
  const parsed = <A>(text: string, decode: (text: string) => Option.Option<A>) =>
    Option.match(decode(text), {
      onNone: () => Effect.fail(showcaseError(REASONS.unreachable)),
      onSome: Effect.succeed,
    });

  /** Fails unless GitHub is still signed in as the account the person saw. */
  const expectLogin = (login: string, uncertain: boolean) =>
    gh(["user", "--jq", ".login"]).pipe(
      Effect.mapError((error) => showcaseError(reasonFor(error), uncertain)),
      Effect.flatMap((current) =>
        current.toLowerCase() === login.toLowerCase()
          ? Effect.void
          : Effect.fail(
              showcaseError(
                current.length === 0
                  ? REASONS.unreachable
                  : `GitHub is now signed in as @${current}, not @${login}. Check the account, then share again.`,
                uncertain,
              ),
            ),
      ),
    );

  /** The person's fork of the Showcase, made if they have none, once it answers. */
  const forkFor = (login: string) =>
    Effect.gen(function* () {
      const fork = yield* gh(
        [
          "--method",
          "POST",
          `repos/${THEME_SHOWCASE_REPOSITORY}/forks`,
          "--jq",
          "{name: .full_name, owner: .owner.login}",
        ],
        { body: { default_branch_only: true }, timeoutMs: WRITE_TIMEOUT_MS },
      ).pipe(
        Effect.mapError((error) => showcaseError(reasonFor(error))),
        Effect.flatMap((text) => parsed(text, decodeFork)),
      );
      if (fork.owner.toLowerCase() !== login.toLowerCase()) {
        return yield* showcaseError(
          `GitHub made the fork for @${fork.owner}, not @${login}. Check the account, then share again.`,
        );
      }
      // A new fork takes a moment before it takes commits.
      for (let tries = 1; ; tries++) {
        const ready = yield* gh([
          `repos/${fork.name}/git/ref/heads/main`,
          "--jq",
          ".object.sha",
        ]).pipe(
          Effect.map((sha) => sha.length > 0),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (ready) return fork;
        if (tries >= FORK_READY_TRIES) {
          return yield* showcaseError(
            "GitHub is still setting up your fork of the Showcase. Share again in a minute.",
          );
        }
        yield* Effect.sleep("2 seconds");
      }
    });

  /** The share's branch in the fork, holding one commit that adds the theme's folder. */
  const pushBranch = (input: {
    readonly fork: string;
    readonly branch: string;
    readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>;
    readonly message: string;
  }) =>
    Effect.gen(function* () {
      const fail = (error: GitHubCliError) => showcaseError(reasonFor(error));
      const base = yield* gh([
        `repos/${THEME_SHOWCASE_REPOSITORY}/git/ref/heads/main`,
        "--jq",
        ".object.sha",
      ]).pipe(Effect.mapError(fail), Effect.flatMap(nonEmpty));
      const baseTree = yield* gh([
        `repos/${THEME_SHOWCASE_REPOSITORY}/git/commits/${base}`,
        "--jq",
        ".tree.sha",
      ]).pipe(Effect.mapError(fail), Effect.flatMap(nonEmpty));
      const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      for (const file of input.files) {
        const sha = yield* gh(
          ["--method", "POST", `repos/${input.fork}/git/blobs`, "--jq", ".sha"],
          {
            body: { content: Buffer.from(file.bytes).toString("base64"), encoding: "base64" },
            timeoutMs: WRITE_TIMEOUT_MS,
          },
        ).pipe(Effect.mapError(fail), Effect.flatMap(nonEmpty));
        tree.push({ path: file.path, mode: "100644", type: "blob", sha });
      }
      const treeSha = yield* gh(
        ["--method", "POST", `repos/${input.fork}/git/trees`, "--jq", ".sha"],
        { body: { base_tree: baseTree, tree }, timeoutMs: WRITE_TIMEOUT_MS },
      ).pipe(Effect.mapError(fail), Effect.flatMap(nonEmpty));
      const commit = yield* gh(
        ["--method", "POST", `repos/${input.fork}/git/commits`, "--jq", ".sha"],
        { body: { message: input.message, tree: treeSha, parents: [base] } },
      ).pipe(Effect.mapError(fail), Effect.flatMap(nonEmpty));
      // A branch a try before this made is moved to the new commit.
      yield* gh(["--method", "POST", `repos/${input.fork}/git/refs`, "--jq", ".ref"], {
        body: { ref: `refs/heads/${input.branch}`, sha: commit },
      }).pipe(
        Effect.catch((error) =>
          gitHubHttpStatus(error) === 422
            ? gh(["--method", "PATCH", `repos/${input.fork}/git/refs/heads/${input.branch}`], {
                body: { sha: commit, force: true },
              })
            : Effect.fail(error),
        ),
        Effect.mapError(fail),
      );
    });

  /** The pull request from this share's branch, if GitHub has one; fails when it can't look. */
  const findPullRequest = (head: string) =>
    gh([
      `repos/${THEME_SHOWCASE_REPOSITORY}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=5`,
      "--jq",
      "map({number, url: .html_url})",
    ]).pipe(
      Effect.flatMap((text) =>
        Option.match(decodePullRequests(text), {
          onNone: () => Effect.succeed(Option.none<{ number: number; url: string }>()),
          onSome: (found) => Effect.succeed(Option.fromNullishOr(found[0])),
        }),
      ),
    );

  const openPullRequest = (input: {
    readonly login: string;
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }) =>
    Effect.gen(function* () {
      const earlier = yield* findPullRequest(input.head).pipe(
        Effect.mapError((error) => showcaseError(reasonFor(error))),
      );
      if (Option.isSome(earlier)) return earlier.value;
      // The pull request is what makes the share public: check the account once more.
      yield* expectLogin(input.login, false);
      const outcome = yield* gh(
        [
          "--method",
          "POST",
          `repos/${THEME_SHOWCASE_REPOSITORY}/pulls`,
          "--jq",
          "{number, url: .html_url}",
        ],
        {
          body: {
            title: input.title,
            head: input.head,
            base: "main",
            body: input.body,
            maintainer_can_modify: true,
          },
          timeoutMs: WRITE_TIMEOUT_MS,
        },
      ).pipe(Effect.result);
      if (outcome._tag === "Success") {
        const opened = decodePullRequest(outcome.success);
        if (Option.isSome(opened)) return opened.value;
      } else if (gitHubFailureKind(outcome.failure) !== "unknown") {
        // GitHub answered, and said no: nothing opened.
        return yield* showcaseError(reasonFor(outcome.failure));
      }
      // No clear answer: GitHub may have opened it. Look once before saying so.
      const found = yield* findPullRequest(input.head).pipe(
        Effect.mapError(() => showcaseError(REASONS.uncertain, true)),
      );
      if (Option.isSome(found)) return found.value;
      return yield* showcaseError(REASONS.uncertain, true);
    });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storedShares = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError(() => showcaseError("Threadlines couldn't save the share. Try again.")),
    );

  const submit: ThemeShowcaseShape["submit"] = (input) =>
    shareLock.withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* storedShares(submissionsRepo.list);
        const own = rows.find((row) => row.submissionId === input.submissionId);
        const settled = own === undefined ? null : toSubmission(own);
        if (settled !== null) return settled;

        const share = yield* buildShare(input);
        if (share.problems.length > 0 || share.pictureBytes === null) {
          return yield* showcaseError(
            `It can't be shared yet:\n- ${share.problems.join("\n- ") || "Its picture couldn't be drawn."}`,
          );
        }
        // The list says which folders are taken and what's already there: share only against a fresh one.
        const showcase = yield* list({});
        if (showcase.issue !== null) {
          return yield* showcaseError(
            showcase.issue === "updateNeeded"
              ? "The Showcase changed. Update Threadlines to share to it."
              : "Couldn't reach the Showcase. Check your connection and try again.",
          );
        }
        if (showcase.themes.some((entry) => entry.hash === share.hash)) {
          return yield* showcaseError("This theme is already in the Showcase.");
        }
        const inReview = rows.find(
          (row) =>
            row.publishedHash === share.hash &&
            row.state === "inReview" &&
            row.pullRequestUrl !== null,
        );
        const reviewing = inReview === undefined ? null : toSubmission(inReview);
        if (reviewing !== null) return reviewing;

        // An unfinished share of this theme (a restart or a lost answer cut it off,
        // and the dialog was opened again) is picked up under its own id: its branch,
        // and the pull request GitHub may have opened from it, are found, not made twice.
        const before =
          own ??
          rows.find((row) => row.pullRequestUrl === null && row.entryId === share.entry.entryId);
        const submissionId = before?.submissionId ?? input.submissionId;
        const branch = `showcase/${submissionId}`;
        yield* expectLogin(input.login, before !== undefined);
        const slug =
          before?.slug ??
          showcaseSlugFor(share.manifest.name, new Set(showcase.themes.map((entry) => entry.id)));
        const row: ThemeShowcaseSubmissionRow = {
          submissionId,
          entryId: share.entry.entryId,
          sourceHash: share.sourceHash,
          publishedHash: share.hash,
          slug,
          login: input.login,
          pullRequestNumber: null,
          pullRequestUrl: null,
          state: "inReview",
          createdAt: before?.createdAt ?? (yield* nowIso),
          checkedAt: null,
        };
        /** Notes the pull request as the share's, for the row that says what it holds. */
        const settle = (
          pullRequest: { readonly number: number; readonly url: string },
          holds: ThemeShowcaseSubmissionRow,
        ) =>
          Effect.gen(function* () {
            const done: ThemeShowcaseSubmissionRow = {
              ...holds,
              pullRequestNumber: pullRequest.number,
              pullRequestUrl: pullRequest.url,
              checkedAt: yield* nowIso,
            };
            yield* storedShares(submissionsRepo.put(done));
            yield* analytics.record("theme.showcase.shared", {
              ...themeAnalyticsProperties(share.manifest),
              license: share.manifest.credits?.license ?? "none",
              prompt: share.manifest.prompt !== undefined,
            });
            return toSubmission(done) ?? (yield* showcaseError(REASONS.unreachable));
          });

        // Started as another account: that account's pull request, if GitHub opened one, is the share.
        if (before !== undefined && before.login.toLowerCase() !== input.login.toLowerCase()) {
          const earlier = yield* findPullRequest(`${before.login}:${branch}`).pipe(
            Effect.mapError((error) => showcaseError(reasonFor(error), true)),
          );
          // It holds what that try pushed, not this one's content: its row says so.
          if (Option.isSome(earlier)) return yield* settle(earlier.value, before);
        }
        yield* storedShares(submissionsRepo.put(row));

        const fork = yield* forkFor(input.login);
        const encode = (text: string) => new TextEncoder().encode(text);
        yield* pushBranch({
          fork: fork.name,
          branch,
          message: `Add ${share.manifest.name}`,
          files: [
            {
              path: `themes/${slug}/theme.threadlines-theme`,
              bytes: encode(themeFileText(share.manifest)),
            },
            { path: `themes/${slug}/thumbnail.png`, bytes: share.pictureBytes },
            {
              path: `themes/${slug}/meta.json`,
              bytes: encode(`${JSON.stringify({ sharedBy: fork.owner }, null, 2)}\n`),
            },
          ],
        });
        const pullRequest = yield* openPullRequest({
          login: input.login,
          head: `${fork.owner}:${branch}`,
          title: `Add ${share.manifest.name}`,
          body: pullRequestBody({
            manifest: share.manifest,
            fonts: share.fonts,
            submissionId,
          }),
        });
        return yield* settle(pullRequest, row);
      }),
    );

  /**
   * A share's state now: listed once the list has it (its content, or its
   * folder after a merge, in case a maintainer touched it up); not added when
   * its pull request closed unmerged; in review until then, merged or not.
   */
  const recheck = (
    row: ThemeShowcaseSubmissionRow,
    listed: { readonly hashes: ReadonlySet<string>; readonly ids: ReadonlySet<string> },
  ) =>
    Effect.gen(function* () {
      if (listed.hashes.has(row.publishedHash)) return "listed" as const;
      if (row.pullRequestNumber === null) return row.state;
      const text = yield* gh([
        `repos/${THEME_SHOWCASE_REPOSITORY}/pulls/${row.pullRequestNumber}`,
        "--jq",
        "{state, merged: (.merged_at != null)}",
      ]).pipe(Effect.catch(() => Effect.succeed("")));
      const pull = Option.getOrUndefined(decodePullState(text));
      if (pull === undefined) return row.state;
      // Merged but not in the list yet (the list rebuilds after a merge): still on its way.
      if (pull.merged)
        return listed.ids.has(row.slug) ? ("listed" as const) : ("inReview" as const);
      return pull.state === "closed" ? ("notAdded" as const) : ("inReview" as const);
    });

  const submissions: ThemeShowcaseShape["submissions"] = Effect.gen(function* () {
    const rows = yield* storedShares(submissionsRepo.list);
    const due = rows.filter(
      (row) =>
        row.pullRequestUrl !== null &&
        row.state === "inReview" &&
        (row.checkedAt === null || now() - Date.parse(row.checkedAt) >= STATE_CHECK_MS),
    );
    if (due.length > 0) {
      const showcase = yield* list({});
      const listed = {
        hashes: new Set(showcase.themes.map((entry) => entry.hash)),
        ids: new Set(showcase.themes.map((entry) => entry.id)),
      };
      const checkedAt = yield* nowIso;
      yield* Effect.forEach(
        due,
        (row) =>
          recheck(row, listed).pipe(
            Effect.flatMap((state) =>
              storedShares(submissionsRepo.put({ ...row, state, checkedAt })),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    }
    const latest = due.length > 0 ? yield* storedShares(submissionsRepo.list) : rows;
    return {
      submissions: latest.flatMap((row) => {
        const submission = toSubmission(row);
        return submission === null ? [] : [submission];
      }),
    };
  });

  return ThemeShowcase.of({ list, picture, read, prepare, submit, submissions, listed });
});

export const ThemeShowcaseLive = Layer.effect(ThemeShowcase, makeThemeShowcase());
