/**
 * Reading a child on a linked computer for this server's clients
 * (`links.readThread`, docs/design/child-threads.md, "Opening a child on a
 * computer the app can't see"). A client that isn't connected to that
 * computer still opens the child from its family: this server asks the other
 * one through the link (`peer.thread.read`), which only serves threads this
 * computer's link started. Only a parent here that holds the child is read
 * for, so a client reads exactly the children its families show.
 */
import {
  type AgentThreadReadResult,
  ComputerLinkError,
  type LinksReadThreadInput,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ComputerLinkClientShape } from "./ComputerLinkClient.ts";
import { refuseIgnoredMessageRead } from "./threadToolLinks.ts";

/** How long a read may take before the client is told that computer didn't answer. */
const READ_TIMEOUT = Duration.seconds(15);

const refuse = (detail: string) => Effect.fail(new ComputerLinkError({ detail }));

export function makeLinkedThreadRead(input: {
  readonly client: ComputerLinkClientShape;
  readonly snapshots: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
}) {
  return (request: LinksReadThreadInput): Effect.Effect<AgentThreadReadResult, ComputerLinkError> =>
    Effect.gen(function* () {
      const parent = yield* input.snapshots.getThreadShellById(request.parentThreadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const child = parent?.remoteChildren?.find(
        (candidate) =>
          candidate.environmentId === request.environmentId &&
          candidate.threadId === request.threadId,
      );
      if (child === undefined) {
        return yield* refuse("That thread wasn't started from this computer.");
      }
      return yield* input.client
        .withPeer(
          request.environmentId,
          (peer) =>
            peer["peer.thread.read"]({
              threadId: request.threadId,
              ...(request.after !== undefined ? { after: request.after } : {}),
              ...(request.limit !== undefined ? { limit: request.limit } : {}),
              ...(request.messageId !== undefined ? { messageId: request.messageId } : {}),
              ...(request.offset !== undefined ? { offset: request.offset } : {}),
            }),
          { timeout: READ_TIMEOUT },
        )
        .pipe(
          Effect.map((read) => refuseIgnoredMessageRead(request.messageId, read)),
          Effect.catch((error) =>
            refuse(
              // A removed link says so; anything else may pass.
              error._tag === "ComputerLinkUnavailableError" && !error.revoked
                ? `${child.label} can't be reached right now.`
                : error.detail,
            ),
          ),
        );
    });
}
