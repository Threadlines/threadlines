import { createRequire } from "node:module";
import { expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const notarizeAfterSign = require("../apps/desktop/resources/notarize-after-sign.cjs") as {
  isNonRetryableSubmitError(error: unknown): boolean;
  formatNonRetryableSubmitFailure(error: unknown): string;
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
