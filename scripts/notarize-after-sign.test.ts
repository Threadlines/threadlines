import { createRequire } from "node:module";
import { expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const notarizeAfterSign = require("../apps/desktop/resources/notarize-after-sign.cjs") as {
  isNonRetryableSubmitError(error: unknown): boolean;
  formatNonRetryableSubmitFailure(error: unknown): string;
  redactNotarySecrets(value: string): string;
};

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
