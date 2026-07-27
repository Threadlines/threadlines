/**
 * Playwright's element-resolution engine, lifted out of playwright-core.
 *
 * This is the part of Playwright that runs *in the page*: it parses locator
 * strings (`role=button[name="Sign in"]`, `:has-text()`, `nth=`), finds what
 * they refer to, answers whether an element is visible and enabled, and builds
 * an aria snapshot with stable refs. It is what lets an agent say "the delete
 * button in the third row" and be understood.
 *
 * It is not on any public API. Playwright ships it as a string literal inside
 * `lib/coreBundle.js`, so getting at it means reading that bundle -- which is
 * fine as long as we do it where a failure is loud.
 *
 * So: extracted at build time, from the version the lockfile pins, and checked
 * in. A playwright-core upgrade that moves the literal fails the extractor and
 * the test, in CI, in front of whoever did the upgrade. The alternative -- the
 * one the competitor we studied took -- is to slice the bundle at runtime on
 * the user's machine, keyed on a variable name that is an esbuild module
 * counter. Theirs looks for `source3`; on playwright-core 1.61.1 the injected
 * script is `source4` and `source3` is a 10KB utility script, so their locator
 * targeting is broken in the wild right now and nobody found out at build time.
 *
 * We key on the esbuild annotation naming the original source file instead.
 * That path is Playwright's own repository layout rather than an artifact of
 * how their bundler happened to order modules, so it survives the rebuilds a
 * counter does not.
 */

/** The comment esbuild leaves above the module, and the thing we search for. */
export const INJECTED_SCRIPT_MODULE_PATH =
  "packages/playwright-core/src/generated/injectedScriptSource.ts";

/**
 * Where the extracted script sits, in the source tree and beside the bundle.
 *
 * Named here, once, because four places need to agree on it: the extractor that
 * writes it, the runtime that reads it, the build step that copies it next to
 * the bundle, and the packager that refuses to ship without it. When they
 * disagree the failure is a missing file at the moment an agent asks for a
 * snapshot -- which is exactly how this was found, in a session where the model
 * quietly fell back to screenshots and nobody noticed for hours.
 */
export const VENDOR_DIRECTORY_NAME = "vendor";
export const VENDORED_INJECTED_SCRIPT_FILENAME = "playwrightInjected.js";
export const VENDORED_INJECTED_MANIFEST_FILENAME = "playwrightInjected.json";

/**
 * Below this it is not the injected script.
 *
 * The real one is a few hundred kilobytes. The competitor's check was 100KB and
 * still admitted the wrong module on a later version, so this is a guard
 * against having extracted *something*, not proof of having extracted the
 * right thing -- that is what the marker assertions below are for.
 */
export const INJECTED_SCRIPT_MIN_BYTES = 200_000;

/**
 * Names that have to appear in whatever we pulled out.
 *
 * Each is a capability we depend on, so a future version that drops or renames
 * one should fail here rather than at the moment an agent tries to use it.
 */
export const INJECTED_SCRIPT_REQUIRED_MARKERS = [
  "parseSelector",
  "querySelector",
  "elementState",
  "ariaSnapshot",
] as const;

export class InjectedScriptExtractionError extends Error {
  constructor(reason: string) {
    super(
      `Could not extract Playwright's injected script: ${reason}. ` +
        `This usually means playwright-core changed how it bundles ` +
        `${INJECTED_SCRIPT_MODULE_PATH}. Re-run the extractor and check the result.`,
    );
    this.name = "InjectedScriptExtractionError";
  }
}

/**
 * Pulls the injected script out of a `coreBundle.js` source.
 *
 * Kept as a pure string-in, string-out function so the interesting part -- what
 * we look for and what we refuse -- is testable without a build, a filesystem
 * or a copy of Playwright.
 */
export function extractInjectedScript(bundleSource: string): string {
  const moduleAt = bundleSource.indexOf(`${INJECTED_SCRIPT_MODULE_PATH}"() {`);
  if (moduleAt < 0) {
    throw new InjectedScriptExtractionError(`no module annotated ${INJECTED_SCRIPT_MODULE_PATH}`);
  }

  // The literal is assigned to whichever `sourceN` esbuild happened to number
  // this module. Which one it is does not matter and must not: we found the
  // module by name, and this only walks to its assignment.
  const assignment = /source\d+\s*=\s*'/.exec(bundleSource.slice(moduleAt, moduleAt + 2_000));
  if (assignment === null) {
    throw new InjectedScriptExtractionError("no source assignment follows the module annotation");
  }

  const literalStart = moduleAt + assignment.index + assignment[0].length;
  const literalEnd = findLiteralEnd(bundleSource, literalStart);
  if (literalEnd < 0) {
    throw new InjectedScriptExtractionError("the source literal is unterminated");
  }

  const script = decodeSingleQuotedLiteral(bundleSource.slice(literalStart, literalEnd));
  if (script.length < INJECTED_SCRIPT_MIN_BYTES) {
    throw new InjectedScriptExtractionError(
      `extracted ${script.length} bytes, expected at least ${INJECTED_SCRIPT_MIN_BYTES}`,
    );
  }
  const missing = INJECTED_SCRIPT_REQUIRED_MARKERS.filter((marker) => !script.includes(marker));
  if (missing.length > 0) {
    throw new InjectedScriptExtractionError(`extracted script is missing ${missing.join(", ")}`);
  }
  return script;
}

/** The closing quote of a single-quoted literal, respecting backslash escapes. */
function findLiteralEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'") {
      return index;
    }
  }
  return -1;
}

/**
 * The literal's own escapes, undone.
 *
 * `JSON.parse` cannot be used: this is a single-quoted JavaScript literal, and
 * it contains unescaped double quotes on nearly every line.
 */
function decodeSingleQuotedLiteral(raw: string): string {
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "\\") {
      out += raw[index];
      continue;
    }
    index += 1;
    const escaped = raw[index];
    switch (escaped) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        out += "\0";
        break;
      case "u": {
        // Both \uXXXX and \u{XXXXX}.
        if (raw[index + 1] === "{") {
          const close = raw.indexOf("}", index);
          out += String.fromCodePoint(Number.parseInt(raw.slice(index + 2, close), 16));
          index = close;
          break;
        }
        out += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 5), 16));
        index += 4;
        break;
      }
      case "x":
        out += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 3), 16));
        index += 2;
        break;
      default:
        // Including \\ , \' and a backslash before a newline.
        out += escaped ?? "";
    }
  }
  return out;
}
