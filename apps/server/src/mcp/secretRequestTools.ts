/**
 * `secret_request`: an agent asks the user for an API key, token or password
 * on a private card instead of in chat (docs/design/secret-requests.md). The
 * call only puts a card in front of the user and returns at once; the value
 * goes from the card to its one destination and never through the agent's
 * conversation. Served on the room endpoint wherever `app_guide` is, never
 * to a side runtime. Loaded up front: a model that can't see it asks in chat.
 *
 * Agents without instructions (ACP) learn when to use it from the
 * description alone, so the description carries the rules.
 */
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { SECRET_REQUEST_TOOL_NAME } from "./roomToolAccess.ts";

export const SecretRequestResult = Schema.Struct({
  outcome: Schema.Literals(["asked_user", "refused", "not_allowed"]),
  detail: Schema.String,
});
export type SecretRequestResult = typeof SecretRequestResult.Type;

export const SecretRequestTool = Tool.make(SECRET_REQUEST_TOOL_NAME, {
  description:
    "Ask the user for an API key, token or password on a private card. Never ask them to paste one into chat. env_file saves NAME=value to a git-ignored env file in your folder; commands keeps it in a private file for your shell commands for 24 hours. You get no value back: the answer arrives as a message, so end your turn or keep working. If the user pastes a key in chat, tell them it is now in the conversation and they may want to replace it.",
  parameters: Schema.Struct({
    name: Schema.String.annotate({ description: "Variable name, e.g. STRIPE_SECRET_KEY." }),
    reason: Schema.String.annotate({
      description: "Why you need it, in one sentence (up to 200 characters).",
    }),
    use: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("env_file"),
        path: Schema.String.annotate({ description: "Relative env file, e.g. .env.local." }),
      }),
      Schema.Struct({
        kind: Schema.Literal("commands"),
        multiline: Schema.optional(Schema.Boolean).annotate({
          description: "For a PEM key or JSON credentials.",
        }),
      }),
    ]),
  }),
  success: SecretRequestResult,
})
  // It only shows a card: the user saves the key, so providers that ask
  // before every non-read-only tool don't ask twice.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Title, "Ask the user for a key");

export const SecretRequestToolkit = Toolkit.make(SecretRequestTool);
