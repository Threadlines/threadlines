/**
 * How long someone counts as using Threadlines on a computer after they last
 * touched it (docs/design/push-alerts.md). Phones that asked to stay quiet do
 * so meanwhile, and past it an open window stops saying it shows its thread,
 * since nobody may be there to see it.
 */
export const COMPUTER_IN_USE_MS = 5 * 60_000;
