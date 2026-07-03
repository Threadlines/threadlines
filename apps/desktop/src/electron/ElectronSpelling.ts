import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const SUGGESTION_TIMEOUT = Duration.millis(250);
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const MAX_WORD_LENGTH = 100;
const MAX_SUGGESTIONS = 10;

// The macOS spellchecker flags words from sentence context (capitalization
// like "america", contractions like "ive") that Chromium's context-menu
// params carry no dictionary suggestions for, while the OS checker itself
// has ideal guesses. Recover them out of process via JXA so no native
// module is needed. Passing `$()` (nil) as the language keeps the system's
// automatic language selection. The word travels via argv, never via
// script interpolation.
const SPELLING_GUESSES_JXA = [
  "function run(argv) {",
  '  ObjC.import("AppKit");',
  "  const word = String(argv[0]);",
  "  const checker = $.NSSpellChecker.sharedSpellChecker;",
  "  const guesses = checker.guessesForWordRangeInStringLanguageInSpellDocumentWithTag(",
  "    $.NSMakeRange(0, word.length), word, $(), 0);",
  "  return JSON.stringify(ObjC.deepUnwrap(guesses) || []);",
  "}",
].join("\n");

export interface ElectronSpellingShape {
  readonly platformSuggestionsFor: (word: string) => Effect.Effect<ReadonlyArray<string>>;
}

export class ElectronSpelling extends Context.Service<ElectronSpelling, ElectronSpellingShape>()(
  "threadlines/desktop/electron/Spelling",
) {}

export const parsePlatformSuggestions = (output: string): ReadonlyArray<string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const suggestions: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      continue;
    }
    const suggestion = entry.trim();
    if (suggestion.length === 0 || suggestions.includes(suggestion)) {
      continue;
    }
    suggestions.push(suggestion);
    if (suggestions.length >= MAX_SUGGESTIONS) {
      break;
    }
  }
  return suggestions;
};

export const layer = Layer.effect(
  ElectronSpelling,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return ElectronSpelling.of({
      platformSuggestionsFor: Effect.fn("desktop.spelling.platformSuggestionsFor")(function* (
        word: string,
      ): Effect.fn.Return<ReadonlyArray<string>> {
        if (process.platform !== "darwin") {
          return [];
        }
        const trimmedWord = word.trim();
        if (trimmedWord.length === 0 || trimmedWord.length > MAX_WORD_LENGTH) {
          return [];
        }

        const output = yield* spawner
          .string(
            ChildProcess.make(
              "/usr/bin/osascript",
              ["-l", "JavaScript", "-e", SPELLING_GUESSES_JXA, trimmedWord],
              {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "ignore",
                killSignal: "SIGTERM",
                forceKillAfter: PROCESS_TERMINATE_GRACE,
              },
            ),
          )
          .pipe(
            Effect.timeoutOption(SUGGESTION_TIMEOUT),
            Effect.map(Option.getOrElse(() => "")),
            Effect.catch(() => Effect.succeed("")),
          );

        return parsePlatformSuggestions(output);
      }),
    });
  }),
);
