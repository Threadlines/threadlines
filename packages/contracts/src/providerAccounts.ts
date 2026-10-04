/**
 * Extra provider accounts.
 *
 * Wire shapes for "Add another account": the server allocates the instance,
 * creates its private folder on its own disk (the client may be another
 * machine), and writes the instance into settings; the client then starts
 * sign-in for it through the normal provider auth flow. Removal stops the
 * instance before signing it out and deleting the folder Threadlines made.
 *
 * @module providerAccounts
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderAccountAddInput = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  /**
   * A folder the user chose on the server's machine. Absent: Threadlines
   * creates and owns a private folder for the account.
   */
  folder: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type ProviderAccountAddInput = typeof ProviderAccountAddInput.Type;

export const ProviderAccountAddResult = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderAccountAddResult = typeof ProviderAccountAddResult.Type;

export const ProviderAccountRemoveInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderAccountRemoveInput = typeof ProviderAccountRemoveInput.Type;

export class ProviderAccountError extends Schema.TaggedError<ProviderAccountError>()(
  "ProviderAccountError",
  {
    reason: Schema.Literals([
      "unsupportedDriver",
      "invalidFolder",
      "unknownInstance",
      "notAnAccount",
      "settingsFailed",
      "folderFailed",
      "instanceNotReady",
    ]),
    /** Plain-language explanation, safe to show the user. */
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}
