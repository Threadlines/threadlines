/**
 * Links that open a thread for the user from outside the app: the hosted app
 * (`https://app.threadlines.dev`, or the nightly one for a nightly build, as
 * the app pairs phones with) at `/<environmentId>/<threadId>`, the shape phone
 * alerts open. A browser that isn't paired with this computer is asked to
 * pair first.
 */
const HOSTED_APP_ORIGIN = "https://app.threadlines.dev";
const NIGHTLY_HOSTED_APP_ORIGIN = "https://nightly.app.threadlines.dev";

/** The hosted app a build of `version` links to, on its own release channel. */
export const hostedAppOrigin = (version: string) =>
  version.includes("-nightly.") ? NIGHTLY_HOSTED_APP_ORIGIN : HOSTED_APP_ORIGIN;

export const hostedThreadLink = (input: {
  readonly origin: string;
  readonly environmentId: string;
  readonly threadId: string;
}) =>
  `${input.origin}/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
