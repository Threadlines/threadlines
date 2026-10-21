import { createRequire } from "node:module";
import { expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const notarizeAfterSign = require("../apps/desktop/resources/notarize-after-sign.cjs") as {
  isNonRetryableSubmitError(error: unknown): boolean;
  formatNonRetryableSubmitFailure(error: unknown): string;
  redactNotarySecrets(value: string): string;
  runStaplerWithRetries(
    action: string,
    appPath: string,
    options: {
      attempts: number;
      run: (action: string, appPath: string) => void;
      wait: (seconds: number) => void;
    },
  ): void;
  validateStapledTicket(
    appPath: string,
    options: {
      attempts: number;
      run: (action: string, appPath: string) => void;
      wait: (seconds: number) => void;
    },
  ): void;
  isStaplerNetworkFailure(error: unknown): boolean;
};

const staplerDrop = () => new Error("Command failed: xcrun stapler validate (Error 68)");

// What stapler printed when Apple's ticket service dropped the connection
// during the first 0.7.0 release run.
const DROPPED_OUTPUT =
  'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\n' +
  "CloudKit's response is inconsistent with expections: (null)\n" +
  "The validate action failed! Error 68.\n";

const staplerFailure = (output: string, status: number | null, signal: string | null = null) =>
  Object.assign(new Error(`xcrun stapler validate failed with exit code ${status}.`), {
    output,
    status,
    signal,
  });

const connectionLost = () => staplerFailure(DROPPED_OUTPUT, 68);
const noTicket = () =>
  staplerFailure("Threadlines.app does not have a ticket stapled to it.\n", 65);

it("excuses only failures that never got an answer from Apple", () => {
  expect(notarizeAfterSign.isStaplerNetworkFailure(connectionLost())).toBe(true);
  // A real answer whose path happens to contain the error domain's name.
  expect(
    notarizeAfterSign.isStaplerNetworkFailure(
      staplerFailure(
        "/tmp/NSURLErrorDomain/Threadlines.app does not have a ticket stapled to it.\n",
        65,
      ),
    ),
  ).toBe(false);
  // A bad server response means Apple did answer.
  expect(
    notarizeAfterSign.isStaplerNetworkFailure(
      staplerFailure(
        'error is Error Domain=NSURLErrorDomain Code=-1011 "bad server response"\n' +
          "The validate action failed! Error 68.\n",
        68,
      ),
    ),
  ).toBe(false);
  // Stapler stopped by a signal never finished its check.
  expect(
    notarizeAfterSign.isStaplerNetworkFailure(staplerFailure(DROPPED_OUTPUT, null, "SIGTERM")),
  ).toBe(false);
});

it("lets the build continue when validate never reaches Apple", () => {
  let calls = 0;

  notarizeAfterSign.validateStapledTicket("/tmp/Threadlines.app", {
    attempts: 4,
    run: () => {
      calls += 1;
      throw connectionLost();
    },
    wait: () => {},
  });

  expect(calls).toBe(4);
});

it("still fails the build when Apple answers that the ticket is wrong", () => {
  let calls = 0;

  expect(() =>
    notarizeAfterSign.validateStapledTicket("/tmp/Threadlines.app", {
      attempts: 4,
      run: () => {
        calls += 1;
        throw calls === 2 ? noTicket() : connectionLost();
      },
      wait: () => {},
    }),
  ).toThrow(/exit code 65/u);
  expect(calls).toBe(4);
});

it("fails the build when the wait between validate attempts fails", () => {
  expect(() =>
    notarizeAfterSign.validateStapledTicket("/tmp/Threadlines.app", {
      attempts: 4,
      run: () => {
        throw connectionLost();
      },
      wait: () => {
        throw new Error("sleep: command not found");
      },
    }),
  ).toThrow(/sleep: command not found/u);
});

it("retries a stapler action until Apple's lookup answers", () => {
  const calls: string[] = [];
  const waits: number[] = [];
  let failuresLeft = 2;

  notarizeAfterSign.runStaplerWithRetries("validate", "/tmp/Threadlines.app", {
    attempts: 4,
    run: (action, appPath) => {
      calls.push(`${action} ${appPath}`);
      if (failuresLeft-- > 0) throw staplerDrop();
    },
    wait: (seconds) => waits.push(seconds),
  });

  expect(calls).toEqual(Array(3).fill("validate /tmp/Threadlines.app"));
  expect(waits).toEqual([30, 30]);
});

it("fails the build when a stapler action fails on every attempt, dropped connections included", () => {
  let calls = 0;

  expect(() =>
    notarizeAfterSign.runStaplerWithRetries("staple", "/tmp/Threadlines.app", {
      attempts: 3,
      run: () => {
        calls += 1;
        throw connectionLost();
      },
      wait: () => {},
    }),
  ).toThrow(/exit code 68/u);
  expect(calls).toBe(3);
});

it("treats Apple notarization agreement failures as non-retryable", () => {
  const error = new Error(
    "notarytool submit failed with exit code 1.\n\n" +
      "Error: HTTP status code: 403. A required agreement is missing or has expired. " +
      "This request requires an in-effect agreement that has not been signed or has expired.",
  );

  expect(notarizeAfterSign.isNonRetryableSubmitError(error)).toBe(true);
});

it("keeps transient notarization submit failures retryable", () => {
  const error = new Error("notarytool submit failed with exit code 1.\n\nnetwork timeout");

  expect(notarizeAfterSign.isNonRetryableSubmitError(error)).toBe(false);
});

it("formats notarization agreement failures with the operator action", () => {
  const message = notarizeAfterSign.formatNonRetryableSubmitFailure(
    new Error("HTTP status code: 403. A required agreement is missing or has expired."),
  );

  expect(message).toMatch(/sign the pending Apple Developer or App Store Connect agreement/u);
  expect(message).toMatch(/APPLE_API_ISSUER/u);
});

it("redacts Apple credentials from notarytool output", () => {
  const previousKey = process.env.APPLE_API_KEY;
  const previousKeyId = process.env.APPLE_API_KEY_ID;
  const previousIssuer = process.env.APPLE_API_ISSUER;
  process.env.APPLE_API_KEY = "/tmp/AuthKey_sensitive.p8";
  process.env.APPLE_API_KEY_ID = "SENSITIVE_KEY_ID";
  process.env.APPLE_API_ISSUER = "sensitive-issuer";

  try {
    const redacted = notarizeAfterSign.redactNotarySecrets(
      "failed with /tmp/AuthKey_sensitive.p8 SENSITIVE_KEY_ID sensitive-issuer",
    );
    expect(redacted).not.toContain("AuthKey_sensitive");
    expect(redacted).not.toContain("SENSITIVE_KEY_ID");
    expect(redacted).not.toContain("sensitive-issuer");
    expect(redacted).toContain("[REDACTED APPLE_API_KEY]");
  } finally {
    if (previousKey === undefined) delete process.env.APPLE_API_KEY;
    else process.env.APPLE_API_KEY = previousKey;
    if (previousKeyId === undefined) delete process.env.APPLE_API_KEY_ID;
    else process.env.APPLE_API_KEY_ID = previousKeyId;
    if (previousIssuer === undefined) delete process.env.APPLE_API_ISSUER;
    else process.env.APPLE_API_ISSUER = previousIssuer;
  }
});
