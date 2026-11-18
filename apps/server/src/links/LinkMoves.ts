// @effect-diagnostics nodeBuiltinImport:off
/**
 * Threads linked computers move here (docs/design/fleet.md, Part 3, "Import
 * on B"). A move is offered (`prepare`), held for this computer's user under
 * Ask first, received in chunks, checked, and imported in stages: fetch the
 * commits, make its own worktree, apply the changes and new files, then one
 * `thread.import` that creates the thread with its history. The thread
 * existing is the commit. Commit and abort run under one lock per transfer,
 * and the commit waits for the engine's answer without letting go, so an
 * abort that was confirmed can never be followed by a thread appearing.
 *
 * Receive before allow (Part 3c): an asking computer that offers so
 * (`stagedApproval`) sends the bytes while a move waits for Allow, and hears
 * `staged_awaiting_approval` once all are here; Allow then imports it with
 * nobody sending. Held moves don't count against the moves in flight, which
 * refuse as `busy` (offer again later); they have their own limits per link,
 * which refuse as `staging_full` (final). Don't allow, and the day's expiry,
 * delete what was staged.
 *
 * Every resource a move makes here is named from its transfer key (a hash of
 * the link and the transfer id): the staging folder, the git ref, the
 * worktree, the thread and its message ids. Nothing a peer sends is used as a
 * path without checking it against this computer's filesystem rules.
 */
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import {
  type ChatAttachment,
  ChildRequestId,
  CommandId,
  type ComputerLinkPendingRequest,
  ComputerLinkError,
  EnvironmentId,
  EventId,
  GENERAL_CHATS_PROJECT_ID,
  isScratchMoveManifest,
  type LinksRespondRequestInput,
  MessageId,
  type OrchestrationProposedPlan,
  type OrchestrationQueuedFollowUp,
  type OrchestrationThreadGoal,
  type OrchestrationThreadLinkedPullRequest,
  type PeerMoveChunkInput,
  type PeerMoveInput,
  type PeerMoveManifest,
  type PeerMovePart,
  type PeerMovePrepareInput,
  type PeerMoveAbortCode,
  type PeerMoveReadinessInput,
  type PeerMoveReadinessResult,
  type PeerMoveRefusalCode,
  type PeerMoveSession,
  type PeerMoveState,
  type PeerMoveThreadState,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type PullRequestMergeMethod,
  type ThreadMovedFrom,
  type RuntimeMode,
  PEER_MOVE_CHUNK_MAX_BYTES,
  PEER_MOVE_FAMILY_MAX_STAYED,
  PEER_MOVE_MAX_STARTED_THERE,
  PEER_MOVE_ROOM_MAX_PARTICIPANTS,
  PEER_MOVE_STATE_MAX_BYTES,
  PEER_MOVE_STATE_MAX_CHECK_BACKS,
  PEER_MOVE_STATE_MAX_PLANS,
  PEER_MOVE_STATE_MAX_PULL_REQUESTS,
  PEER_MOVE_STATE_MAX_QUEUED,
  PeerRpcError,
  ThreadId,
  type ThreadImportMessage,
  type ThreadRemoteOrigin,
  type ThreadMoveRespondManyInput,
  type ThreadMoveRespondManyResult,
  TurnId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { receivedPathRefusal, writeReceivedFile } from "../fs/receivedFiles.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import {
  movedPullRequestSwitchesWords,
  pullRequestSwitchesWords,
} from "@threadlines/shared/threadMoveProjection";
import {
  isValidParticipantId,
  participantSessionKey,
} from "@threadlines/shared/threadParticipants";
import { arrivalMessageText } from "../moves/arrivalMessage.ts";
import { MOVE_MAX_BYTES } from "../moves/moveExport.ts";
import { derivedUuid } from "../orchestration/childRequestIds.ts";
import { generalChatThreadScratchCwd } from "../orchestration/generalChats.ts";

import { clampLaunchToCeiling } from "../orchestration/childThreadDecisions.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ComputerLinkRepository } from "./ComputerLinkRepository.ts";
import { linkMoveCopyThreadId, linkMoveKey, linkMoveThreadId } from "../moves/linkMoveIds.ts";
import {
  type AdoptionArrival,
  adoptionApartWords,
  adoptionRefusal,
  awaitsLoneMoveAnswer,
} from "../orchestration/threadMoveDecisions.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../persistence/Services/ProjectionThreads.ts";
import { discardSessionFiles, releaseSessionFiles } from "../provider/nativeSession.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { RelayDeviceRepository } from "../relay/RelayDeviceRepository.ts";
import { GitHubCli } from "../sourceControl/GitHubCli.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { listThreadAgents } from "../threads/threadOperations.ts";
import { makeKeyedLock } from "./keyedLock.ts";
import {
  movedParticipantId,
  remapOutsideWork,
  remapRoomActivity,
  remapRoomMessage,
  type RoomAgentResolution,
  type RoomArrival,
  roomArrivalOf,
} from "./roomImport.ts";
import { LinkMoveRepository, type LinkMoveRow } from "./LinkMoveRepository.ts";
import { LinkRequests, linkIdentityRefusal, type PeerLink } from "./LinkRequests.ts";

/** A move nobody allowed, or that stopped arriving, ends after a day. */
export const LINK_MOVE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A family member that arrived and waits for a relative (its parent can wait
 * on its other threads for a long time) waits a week before it ends. The
 * computer it left drops it sooner once that relative's move ends there.
 */
export const LINK_MOVE_FAMILY_TTL_MS = 7 * LINK_MOVE_TTL_MS;
/**
 * Moves in flight one link may have here at once, and all links together:
 * every unfinished move except one held for this computer's user with every
 * byte here already (those have their own limits, below), so the caps always
 * drain. A move past them is refused as `busy`: the asking computer offers it
 * again later.
 */
const MAX_OPEN_MOVES_PER_LINK = 2;
const MAX_OPEN_MOVES = 4;
/**
 * Moves one link may have held here for this computer's user's Allow, taking
 * their bytes before it (docs/design/fleet.md, Part 3c), and the bytes they
 * declare together. A move past them is refused as `staging_full`, a final
 * answer.
 */
export const MAX_STAGED_MOVES_PER_LINK = 20;
export const MAX_STAGED_BYTES_PER_LINK = 2 * 1024 * 1024 * 1024;
const MAX_MOVE_PARTS = 20_000;
/**
 * The most a move may write here beyond the project as its remote has it: the
 * files its commits change, what its binary changes unpack to, its patch and
 * its new files. A small compressed payload can't grow past it.
 */
const MOVE_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const SWEEP_EVERY = "1 hour";
const GIT_FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;

export interface LinkMovesShape {
  /** Each answer fails when this computer couldn't read or record the move: the asking computer drops it. */
  readonly prepare: (
    link: PeerLink,
    input: PeerMovePrepareInput,
  ) => Effect.Effect<PeerMoveState, PeerRpcError>;
  readonly chunk: (
    link: PeerLink,
    input: PeerMoveChunkInput,
  ) => Effect.Effect<PeerMoveState, PeerRpcError>;
  readonly finish: (
    link: PeerLink,
    input: PeerMoveInput,
  ) => Effect.Effect<PeerMoveState, PeerRpcError>;
  readonly status: (
    link: PeerLink,
    input: PeerMoveInput,
  ) => Effect.Effect<PeerMoveState, PeerRpcError>;
  /** Fails when the outcome couldn't be recorded: the asking computer asks again. */
  readonly abort: (
    link: PeerLink,
    input: PeerMoveInput,
  ) => Effect.Effect<PeerMoveState, PeerRpcError>;
  /** This computer's user answers a waiting move; false when no move has that id. */
  readonly respond: (input: LinksRespondRequestInput) => Effect.Effect<boolean, ComputerLinkError>;
  /**
   * Allow all, or Don't allow, for moves from one linked computer (the
   * grouped card, docs/design/fleet.md, Part 3c): each answered on its own,
   * as `respond` would, so one that can't be answered doesn't stop the rest.
   */
  readonly respondMany: (
    input: ThreadMoveRespondManyInput,
  ) => Effect.Effect<ThreadMoveRespondManyResult>;
  readonly pending: Effect.Effect<ReadonlyArray<ComputerLinkPendingRequest>>;
  readonly pendingChanges: Stream.Stream<void>;
  /** An inbound link was removed: its unfinished moves are dropped. */
  readonly dropLink: (deviceId: string) => Effect.Effect<void>;
  /**
   * Whether a project's pull requests can be watched here (`peer.move.readiness`,
   * docs/design/fleet.md, Part 3e, (c)): asked before a thread with switches on moves.
   */
  readonly readiness: (
    link: PeerLink,
    input: PeerMoveReadinessInput,
  ) => Effect.Effect<PeerMoveReadinessResult, PeerRpcError>;
  /** Settle what the previous process left, and sweep hourly. */
  readonly startReactor: () => Effect.Effect<void, never, Scope.Scope>;
}

export class LinkMoves extends Context.Service<LinkMoves, LinkMovesShape>()(
  "threadlines/links/LinkMoves",
) {}

/** An import stage that can't go on: the move ends aborted with this reason. */
class ImportStop extends Data.TaggedError("ImportStop")<{ readonly reason: string }> {}

/** How a family's child lands here: under its parent, or as its own thread with why. */
interface FamilyLanding {
  readonly lineage?: { readonly parentThreadId: ThreadId; readonly parentTurnId: TurnId | null };
  readonly left?: string;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export { linkMoveKey, linkMoveThreadId } from "../moves/linkMoveIds.ts";

/**
 * hash(link, family id): a family's key here (docs/design/fleet.md, Part 3f,
 * (g)). Its members' threads, turns and messages are named from it and their
 * ids there, so each can name the others before they arrive. From the link
 * the move came over, so no other computer can name a family's threads.
 */
export const linkFamilyKey = (linkDeviceId: string, familyId: string) =>
  createHash("sha256").update(`family\u0000${linkDeviceId}\u0000${familyId}`).digest("hex");

/** A family member's thread here, from its family's key and its id there. */
export const linkFamilyThreadId = (familyKey: string, sourceThreadId: string) =>
  ThreadId.make(derivedUuid("link-move-family-thread", familyKey, sourceThreadId));

/**
 * A moved message's id here: from the move's transfer key, or for a family
 * member from the family's key and the member's own thread there, so two
 * members never name a message alike whatever ids their manifests carry.
 */
export const linkMoveMessageId = (
  row: Pick<LinkMoveRow, "transferKey" | "familyKey" | "manifest">,
  id: string,
) =>
  MessageId.make(
    row.familyKey === null
      ? derivedUuid("link-move-message", row.transferKey, id)
      : derivedUuid("link-move-message", row.familyKey, row.manifest.source.threadId, id),
  );

/**
 * A moved turn's id here, as linkMoveMessageId names messages. `sourceThreadId`
 * is the thread there whose turn it is: a child names its parent's turn as
 * the parent's own import names it.
 */
export const linkMoveTurnId = (
  row: Pick<LinkMoveRow, "transferKey" | "familyKey">,
  sourceThreadId: string,
  id: string,
) =>
  TurnId.make(
    row.familyKey === null
      ? derivedUuid("link-move-turn", row.transferKey, id)
      : derivedUuid("link-move-turn", row.familyKey, sourceThreadId, id),
  );

/** The words a child's move ends with when its parent's didn't land here. */
const PARENT_DIDNT_MOVE = "Its parent thread didn't move.";
/** The words a member's move ends with when the folder it works in didn't come. */
const OWNER_DIDNT_MOVE = "The thread whose folder it works in didn't move.";

/**
 * A folder is shared only within one project: a member and the folder's
 * owner must name the same project (its canonical key and subdirectory), or
 * a peer could have this computer approve a thread in one project and run it
 * in another's checkout (docs/design/fleet.md, Part 3f).
 */
const OTHER_PROJECTS_FOLDER = "The folder it works in belongs to another project.";
/** A repository move's project; a General Chats move names none to share. */
const movedProjectOf = (manifest: PeerMoveManifest) =>
  "canonicalKey" in manifest.project ? manifest.project : null;
export const sameProjectAs = (a: PeerMoveManifest, b: PeerMoveManifest) => {
  const left = movedProjectOf(a);
  const right = movedProjectOf(b);
  return (
    left !== null &&
    right !== null &&
    left.canonicalKey === right.canonicalKey &&
    (left.subdirectory ?? "") === (right.subdirectory ?? "")
  );
};

const isWindows = process.platform === "win32";
const isCaseInsensitive = process.platform === "win32" || process.platform === "darwin";
const foldCase = (path: string) => (isCaseInsensitive ? path.toLowerCase() : path);

/** Why a moved file's path can't be written here, or null (the shared receive rule). */
export const movePathRefusal = receivedPathRefusal;

/**
 * Why a peer's manifest can't be taken, or null: within the size limit, its
 * parts contiguous from zero and summing to the total, at most one bundle and
 * one diff, the bundle there exactly when a base is named, every file part
 * with a path this computer can write and no two the same here.
 */
export function moveManifestRefusal(manifest: PeerMoveManifest): string | null {
  if (manifest.totalBytes > MOVE_MAX_BYTES) return "it's bigger than 100 MB";
  if (manifest.parts.length > MAX_MOVE_PARTS) return "it has too many files";
  const sorted = manifest.parts.toSorted((left, right) => left.offset - right.offset);
  let next = 0;
  for (const part of sorted) {
    if (part.offset !== next) return "its parts don't line up";
    next += part.length;
  }
  if (next !== manifest.totalBytes) return "its parts don't add up";
  const count = (kind: PeerMovePart["kind"]) =>
    manifest.parts.filter((part) => part.kind === kind).length;
  if (isScratchMoveManifest(manifest)) {
    // A general chat's folder is its files alone.
    if (count("bundle") > 0 || count("diff") > 0) return "a general chat carries no commits";
  } else {
    if (count("bundle") > 1 || count("diff") > 1) return "it has more than one bundle or diff";
    if ((count("bundle") === 1) !== (manifest.git.baseSha !== null)) {
      return "its commits don't match its base";
    }
  }
  const seen = new Set<string>();
  for (const part of manifest.parts) {
    if (part.kind === "file") {
      if (part.path === undefined || part.mode === undefined) return "a file has no path";
      const refusal = movePathRefusal(part.path);
      if (refusal !== null) return refusal;
      if (part.mode === "symlink" && isWindows) return `"${part.path}" is a symbolic link`;
      const folded = foldCase(part.path);
      if (seen.has(folded)) return `"${part.path}" is there twice`;
      seen.add(folded);
    }
    if (part.kind === "attachment" && part.attachmentId === undefined) {
      return "an attachment has no id";
    }
    // Its path only tells the session's files apart; the agent names where they go.
    if (part.kind === "session" && part.path === undefined) return "a session file has no name";
  }
  const ownSessionParts = manifest.parts.filter(
    (part) => part.kind === "session" && part.participantId === undefined,
  ).length;
  if (ownSessionParts > 0 !== (manifest.session !== undefined)) {
    return "its session doesn't match its files";
  }
  if ((manifest.startedThere ?? []).length > PEER_MOVE_MAX_STARTED_THERE) {
    return "it names too many threads it started here";
  }
  return (
    moveRoomRefusal(manifest) ??
    moveFamilyRefusal(manifest) ??
    moveLinkLineageRefusal(manifest) ??
    moveStateRefusal(manifest.thread.state)
  );
}

/**
 * Why a thread moving across the link its work came over can't be taken, or
 * null (docs/design/fleet.md, Part 3f, (h)): it names one parent or one
 * home, never both, never itself, and never with a family. What it names is
 * only ever a claim: the import checks it against this computer's own link
 * and records (linkLanding).
 */
function moveLinkLineageRefusal(manifest: PeerMoveManifest): string | null {
  const lineage = manifest.linkLineage;
  if (lineage === undefined) return null;
  if ((lineage.remoteParent === undefined) === (lineage.home === undefined)) {
    return "it names one parent or one home, not both";
  }
  if (manifest.family !== undefined) return "a thread moving with its family moves on no link";
  if (lineage.remoteParent?.threadId === manifest.source.threadId) {
    return "it names itself as its parent";
  }
  return null;
}

/**
 * Why a moved family member can't be taken, or null (docs/design/fleet.md,
 * Part 3f, (g)): it names neither itself as its parent nor its own folder's
 * owner, a parent's turn only with the parent, and lists within bounds. One
 * that shares another's folder carries none of the folder's files and no
 * commits of its own; a general chat shares no folder.
 */
function moveFamilyRefusal(manifest: PeerMoveManifest): string | null {
  const family = manifest.family;
  if (family === undefined) return null;
  const self = manifest.source.threadId;
  if (family.parentThreadId === self) return "it names itself as its parent";
  if (family.parentTurnId !== undefined && family.parentThreadId === undefined) {
    return "it names a parent's turn without its parent";
  }
  if (
    (family.stayed ?? []).length > PEER_MOVE_FAMILY_MAX_STAYED ||
    (family.remoteStayed ?? []).length > PEER_MOVE_FAMILY_MAX_STAYED
  ) {
    return "it names too many threads";
  }
  if (family.sharesCheckoutOf === undefined) return null;
  if (family.sharesCheckoutOf === self) return "it shares its own folder";
  if (isScratchMoveManifest(manifest)) return "a general chat shares no folder";
  if (manifest.git.baseSha !== null) return "a thread in another's folder carries no commits";
  if (
    manifest.parts.some(
      (part) => part.kind === "bundle" || part.kind === "diff" || part.kind === "file",
    )
  ) {
    return "a thread in another's folder carries none of its files";
  }
  return null;
}

/**
 * Why a moved room can't be taken, or null (docs/design/fleet.md, Part 3f,
 * (i)): at most PEER_MOVE_ROOM_MAX_PARTICIPANTS agents, each named once, a
 * session part only for an agent the manifest says carries one (and each
 * such agent with its files), and every message, mark and part naming an
 * agent of the room.
 */
function moveRoomRefusal(manifest: PeerMoveManifest): string | null {
  const room = manifest.thread.room;
  const participants = room?.participants ?? [];
  if (participants.length > PEER_MOVE_ROOM_MAX_PARTICIPANTS) return "its room has too many agents";
  const ids = new Set<string>();
  for (const participant of participants) {
    if (!isValidParticipantId(participant.id) || ids.has(participant.id)) {
      return "its room names an agent twice";
    }
    ids.add(participant.id);
    if (participant.session !== undefined && participant.agent === undefined) {
      return "its room carries a session for an agent that doesn't come";
    }
  }
  const known = (id: string | null | undefined) => id === null || id === undefined || ids.has(id);
  const sessionOwners = new Set<string>();
  for (const part of manifest.parts) {
    if (part.participantId === undefined) continue;
    if (part.kind !== "session" || !ids.has(part.participantId)) {
      return "a part names an agent the room doesn't have";
    }
    sessionOwners.add(part.participantId);
  }
  for (const participant of participants) {
    if (sessionOwners.has(participant.id) !== (participant.session !== undefined)) {
      return "a room agent's session doesn't match its files";
    }
  }
  for (const message of manifest.thread.messages) {
    if (!known(message.participantId) || !known(message.fromAgent?.participantId)) {
      return "a message names an agent the room doesn't have";
    }
  }
  for (const mark of manifest.thread.outsideWork ?? []) {
    if (!known(mark.participantId)) return "an outside mark names an agent the room doesn't have";
  }
  return null;
}

/** Why what a moved thread had going can't be taken, or null: within its bounds. */
function moveStateRefusal(state: PeerMoveThreadState | undefined): string | null {
  if (state === undefined) return null;
  if (JSON.stringify(state).length > PEER_MOVE_STATE_MAX_BYTES) {
    return "what it had going is too big";
  }
  if ((state.queuedFollowUps ?? []).length > PEER_MOVE_STATE_MAX_QUEUED) {
    return "it has too many queued messages";
  }
  if ((state.checkBacks ?? []).length > PEER_MOVE_STATE_MAX_CHECK_BACKS) {
    return "it has too many check-backs";
  }
  if ((state.proposedPlans ?? []).length > PEER_MOVE_STATE_MAX_PLANS) {
    return "it has too many plans";
  }
  if ((state.pullRequests?.linked ?? []).length > PEER_MOVE_STATE_MAX_PULL_REQUESTS) {
    return "it has too many pull requests";
  }
  return null;
}

/** The git half of a move's manifest; a general chat has none. */
const gitOf = (manifest: PeerMoveManifest) =>
  isScratchMoveManifest(manifest) ? null : manifest.git;

/** What the allow card says a move brings: a general chat's files count as new files. */
function moveSummaryOf(manifest: PeerMoveManifest) {
  return isScratchMoveManifest(manifest)
    ? { branch: null, trackedFiles: 0, untrackedFiles: manifest.summary.files, unpushedCommits: 0 }
    : {
        branch: manifest.git.branch,
        trackedFiles: manifest.summary.trackedFiles,
        untrackedFiles: manifest.summary.untrackedFiles,
        unpushedCommits: manifest.summary.unpushedCommits,
      };
}

const BASE85 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

/** One line of a git binary patch: its length letter, then base85 groups of five. */
function decodeBase85Line(line: string): Buffer | null {
  const letter = line.charCodeAt(0);
  const length =
    letter >= 65 && letter <= 90 ? letter - 64 : letter >= 97 && letter <= 122 ? letter - 70 : 0;
  const groups = line.slice(1);
  if (length === 0 || groups.length !== Math.ceil(length / 4) * 5) return null;
  const out = Buffer.alloc(Math.ceil(length / 4) * 4);
  for (let group = 0; group < groups.length / 5; group += 1) {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const digit = BASE85.indexOf(groups[group * 5 + index]!);
      if (digit < 0) return null;
      value = value * 85 + digit;
    }
    if (value > 0xffffffff) return null;
    out.writeUInt32BE(value, group * 4);
  }
  return out.subarray(0, length);
}

/**
 * What a patch's binary changes unpack to: each file's new size, from its
 * forward hunk (a `literal` states it; a `delta` states it in the delta's
 * own header, read from the first bytes inflated). Null when a binary hunk
 * doesn't parse, so a patch that can't be measured is refused.
 */
export function binaryPatchBytes(patch: string): number | null {
  const lines = patch.split("\n");
  let total = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "GIT binary patch") continue;
    const header = /^(literal|delta) (\d+)$/.exec(lines[index + 1] ?? "");
    if (header === null) return null;
    if (header[1] === "literal") {
      total += Number.parseInt(header[2]!, 10);
      continue;
    }
    const deflated: Buffer[] = [];
    for (let line = index + 2; line < lines.length && lines[line] !== ""; line += 1) {
      const decoded = decodeBase85Line(lines[line]!);
      if (decoded === null) return null;
      deflated.push(decoded);
      // The header is in the first bytes inflated; 32 lines (1.6 KB) hold
      // any block's code tables and then some, so the rest isn't read.
      if (deflated.length >= 32) break;
    }
    let start: Buffer;
    try {
      start = NodeZlib.inflateSync(Buffer.concat(deflated), {
        finishFlush: NodeZlib.constants.Z_SYNC_FLUSH,
        // 1.6 KB of deflate can't inflate past ~1.7 MB.
        maxOutputLength: 4 * 1024 * 1024,
      });
    } catch {
      return null;
    }
    // Two sizes, seven bits a byte, low first: the source's, then the target's.
    let offset = 0;
    const readSize = () => {
      let size = 0;
      for (let shift = 0; offset < start.length; shift += 7) {
        const byte = start[offset++]!;
        size += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return size;
      }
      return null;
    };
    if (readSize() === null) return null;
    const target = readSize();
    if (target === null) return null;
    total += target;
  }
  return total;
}

const make = Effect.gen(function* () {
  const moves = yield* LinkMoveRepository;
  const requests = yield* LinkRequests;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const threadRows = yield* ProjectionThreadRepository;
  // This computer's own links to others: its device on each (a copy's id there).
  const outboundLinks = yield* ComputerLinkRepository;
  const git = yield* GitVcsDriver;
  const config = yield* ServerConfig;
  const devices = yield* RelayDeviceRepository;
  const identities = yield* RepositoryIdentityResolver;
  const setupScripts = yield* ProjectSetupScriptRunner;
  const environment = yield* ServerEnvironment;
  const providers = yield* ProviderService;
  const sql = yield* SqlClient.SqlClient;

  /** Whether any of `messages` has an id a thread other than `threadId` already holds here. */
  const messageIdsTaken = (
    threadId: ThreadId,
    messages: ReadonlyArray<{ readonly messageId: string }>,
  ) =>
    Effect.gen(function* () {
      const ids = messages.map((message) => message.messageId);
      for (let start = 0; start < ids.length; start += 500) {
        const chunk = ids.slice(start, start + 500);
        const rows = yield* sql<{ readonly found: number }>`
          SELECT 1 AS "found" FROM projection_thread_messages
          WHERE thread_id <> ${threadId} AND message_id IN ${sql.in(chunk)}
          LIMIT 1
        `;
        if (rows.length > 0) return true;
      }
      return false;
    }).pipe(
      Effect.mapError(() => new ImportStop({ reason: `${ownLabel()} couldn't read its threads.` })),
    );
  // GitHub's sign-in, for the pull request switches a move brings; none in a
  // server built without it (tests), which then can't tell.
  const gitHubCli = yield* Effect.serviceOption(GitHubCli);
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  /** The drivers this computer has a ready agent of: why a room agent with none here didn't come. */
  const readyDrivers = Option.isNone(providerRegistry)
    ? Effect.succeed(new Set<string>())
    : providerRegistry.value.getProviders.pipe(
        Effect.map(
          (all) =>
            new Set<string>(
              listThreadAgents(all, { interactionMode: "default" }).agents.map(
                (agent) => agent.driver,
              ),
            ),
        ),
        Effect.orElseSucceed(() => new Set<string>()),
      );
  // Read at each use: the computer can be renamed while this runs.
  const ownLabel = environment.currentLabel;
  const pendingHub = yield* PubSub.sliding<void>(1);
  const announcePending = PubSub.publish(pendingHub, undefined).pipe(Effect.asVoid);
  const lock = makeKeyedLock();
  /** Imports run in the service's own scope, so they end with it. */
  const scope = yield* Effect.scope;
  /** Imports running in this process, so a second `finish` doesn't start another. */
  const importing = new Set<string>();
  /** Imports asked to start while they were ending: each runs once more (runImport). */
  const importAgain = new Set<string>();
  const peerFailure = (detail: string) => new PeerRpcError({ detail });

  const stagingDir = (row: Pick<LinkMoveRow, "transferKey">) =>
    NodePath.join(config.stateDir, "link-moves", row.transferKey);
  const payloadPath = (row: Pick<LinkMoveRow, "transferKey">) =>
    NodePath.join(stagingDir(row), "payload.bin");
  const tempRef = (row: Pick<LinkMoveRow, "transferKey">) =>
    `refs/threadlines/move/${row.transferKey}`;

  /**
   * A move held for Allow that takes its bytes first reads as `receiving`
   * until every byte is here, then `staged_awaiting_approval`; once allowed
   * with every byte here it reads as `importing`, whether its import runs
   * yet or waits for a slot (`waitingToImport`).
   */
  const peerStatus = (row: LinkMoveRow): PeerMoveState["status"] =>
    row.status === "awaiting_approval" && row.stagedApproval
      ? row.bytesReceived >= row.manifest.totalBytes
        ? "staged_awaiting_approval"
        : "receiving"
      : waitingToImport(row) || row.status === "waiting_for_family"
        ? "importing"
        : row.status;
  const stateOf = (row: LinkMoveRow): PeerMoveState => ({
    status: peerStatus(row),
    bytesReceived: row.bytesReceived,
    ...(row.status === "committed" ? { threadId: row.threadId } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.status === "aborted" && row.abortCode !== null ? { abortCode: row.abortCode } : {}),
  });
  const gone = (reason?: string, refusalCode?: PeerMoveRefusalCode): PeerMoveState => ({
    status: "aborted",
    bytesReceived: 0,
    ...(reason !== undefined ? { reason } : {}),
    ...(refusalCode !== undefined ? { refusalCode } : {}),
  });
  /** A move held for Allow whose bytes are all here: it no longer holds a slot in flight. */
  const staged = (row: LinkMoveRow) =>
    row.status === "awaiting_approval" &&
    row.stagedApproval &&
    row.bytesReceived >= row.manifest.totalBytes;
  /**
   * A move sent before Allow, allowed, with every byte here: its import
   * starts once a slot in flight is free (`startImports`), so allowing many
   * at once never runs more imports than the caps.
   */
  const waitingToImport = (row: LinkMoveRow) =>
    row.status === "receiving" &&
    row.stagedApproval &&
    row.bytesReceived >= row.manifest.totalBytes;
  /**
   * Holds no slot in flight: waiting for Allow, or for a slot, with every
   * byte here; or waiting for another member of its family (Part 3f, review
   * change 2), so the member it waits for can always get one.
   */
  const holdsNoSlot = (row: LinkMoveRow) =>
    staged(row) || waitingToImport(row) || row.status === "waiting_for_family";
  /**
   * Counts against the link's staging budget: sent before Allow, and its bytes
   * still in staging, waiting for Allow (all here or still arriving) or,
   * allowed, waiting for an import slot; or waiting for its family. Its import
   * holds a slot in flight instead.
   */
  const holdsStaging = (row: LinkMoveRow) =>
    row.status === "waiting_for_family" ||
    (row.stagedApproval && (row.status === "awaiting_approval" || waitingToImport(row)));

  /** A move's row. Fails when it couldn't be read: an outage must never read as "never heard of it". */
  const readRow = (linkDeviceId: string, transferId: string) =>
    moves
      .get(linkDeviceId, transferId)
      .pipe(Effect.mapError(() => peerFailure(`${ownLabel()} couldn't read its moves.`)));

  const runGit = (cwd: string, args: ReadonlyArray<string>, timeoutMs = GIT_TIMEOUT_MS) =>
    git
      .execute({
        operation: "LinkMoves",
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs,
        maxOutputBytes: 4_000_000,
      })
      .pipe(
        Effect.map((result) => ({ ok: result.exitCode === 0, out: result.stdout.trim() })),
        Effect.orElseSucceed(() => ({ ok: false, out: "" })),
      );

  /** The import's command id: its receipt is how a restart knows the import landed. */
  const importCommandId = (row: Pick<LinkMoveRow, "transferKey">) =>
    CommandId.make(`server:link-move:${row.transferKey}:import`);

  /**
   * Whether the import landed: the engine accepted it (the receipt is written
   * with its events), or its thread is here in any state, archived or deleted
   * since included. Fails when that couldn't be read.
   */
  const importLanded = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const receipt = yield* engine.getCommandReceipt(importCommandId(row));
      if (Option.isSome(receipt) && receipt.value.status === "accepted") return true;
      return Option.isSome(yield* threadRows.getById({ threadId: row.threadId }));
    }).pipe(Effect.mapError(() => peerFailure(`${ownLabel()} couldn't check its threads.`)));

  /** The project here a move lands in, and the remote it fetches from. */
  const landing = (manifest: PeerMoveManifest) =>
    Effect.gen(function* () {
      // A general chat lands in this computer's General chats.
      if (isScratchMoveManifest(manifest)) {
        const catalog = yield* snapshots
          .getProjectCatalog()
          .pipe(Effect.orElseSucceed(() => ({ projects: [] as const })));
        const project = catalog.projects.find(
          (entry) => entry.id === GENERAL_CHATS_PROJECT_ID && entry.deletedAt === null,
        );
        return project === undefined
          ? null
          : { project, root: project.workspaceRoot, remoteName: "" };
      }
      const project = yield* requests.projectForKey(
        manifest.project.canonicalKey,
        manifest.project.subdirectory,
      );
      if (project === undefined) return null;
      const identity = yield* identities.resolve(project.workspaceRoot);
      return {
        project,
        root: project.workspaceRoot,
        remoteName: identity?.locator.remoteName ?? "origin",
      };
    });

  // ---------------------------------------------------------------------------
  // Clean-up
  // ---------------------------------------------------------------------------

  /** The note a branch this move made starts its reflog with. */
  const branchNote = (row: Pick<LinkMoveRow, "transferKey">) =>
    `threadlines move ${row.transferKey}`;

  /**
   * Whether this move made `branch`: the oldest entry of its reflog is the
   * note it was made with. One anyone else made (even at the moved commit,
   * or after this move's was deleted) isn't.
   */
  const ownsBranch = (root: string, branch: string, row: Pick<LinkMoveRow, "transferKey">) =>
    runGit(root, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`, "--"]).pipe(
      Effect.map((result) => result.ok && result.out.split("\n").at(-1) === branchNote(row)),
    );

  /**
   * Removes what an aborted move made here: its staging, its worktree and
   * branch, its temp ref. A folder a thread here uses since is left alone,
   * and so is a branch this move didn't make or that moved on since.
   * Recorded only once all of it is gone, so startup and the sweep retry
   * the rest.
   */
  const cleanUp = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      // A carried agent session first: its record lives in the staging, and
      // stays there until its files and binding are taken back.
      const sessionGone = yield* discardCarried(row);
      let clean =
        sessionGone &&
        (yield* Effect.tryPromise(() =>
          NodeFs.rm(stagingDir(row), { recursive: true, force: true }),
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ));
      // A general chat made only its folder.
      if (isScratchMoveManifest(row.manifest)) {
        const folder = row.worktreePath;
        if (folder !== null) {
          const ours = yield* ownsScratchFolder(row, folder);
          if (ours === null) clean = false;
          else if (ours) {
            yield* Effect.promise(() =>
              NodeFs.rm(folder, { recursive: true, force: true }).catch(() => undefined),
            );
            if ((yield* pathState(folder)) !== false) clean = false;
          }
        }
        if (!clean) return;
        yield* moves
          .markCleaned({
            linkDeviceId: row.linkDeviceId,
            transferId: row.transferId,
            now: yield* nowIso,
          })
          .pipe(Effect.ignore);
        return;
      }
      // A family's folder that a member still coming shares (docs/design/
      // fleet.md, Part 3f, (g)) stays until that member lands (then a thread
      // uses it) or is dropped: clean-up stays owed, and the sweep tries again.
      if (row.familyKey !== null && row.manifest.family?.sharesCheckoutOf === undefined) {
        const open = yield* moves.listOpen.pipe(Effect.option);
        const sharedStill =
          Option.isNone(open) ||
          open.value.some(
            (entry) =>
              entry.familyKey === row.familyKey &&
              entry.manifest.family?.sharesCheckoutOf === row.sourceThreadId,
          );
        if (sharedStill) return;
      }
      // The repository recorded when the import began (nothing was made in
      // git before that). One deleted since took its refs and worktree list
      // with it; one that is there but can't be read, or can't be told
      // apart from gone, is retried later.
      const root = row.repoRoot;
      let repo: string | null = null;
      if (root !== null) {
        const there = yield* pathState(root);
        if (there === null) clean = false;
        else if (there) {
          if ((yield* runGit(root, ["rev-parse", "--git-dir"])).ok) repo = root;
          else clean = false;
        }
      }
      if (row.worktreePath !== null) {
        const inUse = yield* pathInUse(row.worktreePath);
        const ours = inUse === false ? yield* ownsWorktree(row.worktreePath, row, repo) : null;
        if (inUse === null || ours === null) {
          clean = false;
        } else if (!inUse) {
          if (repo !== null && ours) {
            yield* runGit(repo, ["worktree", "remove", "--force", row.worktreePath]);
          }
          // A folder this move made goes. Anything else there stays, an
          // empty one excepted (a worktree that was never made).
          yield* Effect.promise(() =>
            ours
              ? NodeFs.rm(row.worktreePath!, { recursive: true, force: true }).catch(
                  () => undefined,
                )
              : NodeFs.rmdir(row.worktreePath!).catch(() => undefined),
          );
          if (ours && (yield* pathState(row.worktreePath)) !== false) clean = false;
          if (repo !== null) {
            yield* runGit(repo, ["worktree", "prune"]);
            // Ours, and still where this move left it: nobody built on it.
            const at = yield* runGit(repo, [
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/heads/${row.branch ?? ""}^{commit}`,
            ]);
            if (
              row.branch !== null &&
              at.ok &&
              at.out === gitOf(row.manifest)?.headSha &&
              (yield* ownsBranch(repo, row.branch, row))
            ) {
              const deleted = yield* runGit(repo, ["branch", "-D", row.branch]);
              if (!deleted.ok) clean = false;
            }
          }
        }
      }
      if (repo !== null) {
        yield* runGit(repo, ["update-ref", "-d", tempRef(row)]);
        const left = yield* runGit(repo, ["rev-parse", "--verify", "--quiet", tempRef(row)]);
        if (left.ok) clean = false;
      }
      if (!clean) return;
      yield* moves
        .markCleaned({
          linkDeviceId: row.linkDeviceId,
          transferId: row.transferId,
          now: yield* nowIso,
        })
        .pipe(Effect.ignore);
    });

  /** Where a general chat moved here keeps its files: its own folder in General chats. */
  const scratchFolderOf = (root: string, row: Pick<LinkMoveRow, "threadId">) =>
    generalChatThreadScratchCwd(root, row.threadId, NodePath);

  /**
   * Whether `folder` is the one this general chat's move made, so clean-up
   * may remove it: it is the folder named from this move's thread, and no
   * thread with that id exists here (only that thread's sessions could have
   * made it otherwise). Null when that can't be read.
   */
  const ownsScratchFolder = (row: LinkMoveRow, folder: string) =>
    Effect.gen(function* () {
      const land = yield* landing(row.manifest);
      const named =
        land !== null
          ? folder === scratchFolderOf(land.root, row)
          : NodePath.basename(folder) === row.threadId &&
            NodePath.basename(NodePath.dirname(folder)) === "threads";
      if (!named) return false;
      const thread = yield* threadRows.getById({ threadId: row.threadId }).pipe(Effect.option);
      if (Option.isNone(thread)) return null;
      return Option.isNone(thread.value);
    });

  /** Whether `path` is there: false only when it's confirmed gone, null when that can't be told. */
  const pathState = (path: string) =>
    Effect.promise(() =>
      NodeFs.lstat(path).then(
        (): boolean | null => true,
        (error: NodeJS.ErrnoException): boolean | null =>
          error.code === "ENOENT" || error.code === "ENOTDIR" ? false : null,
      ),
    );

  /** Two paths name the same place (macOS's /var is /private/var). */
  const samePlace = (left: string, right: string) =>
    Effect.promise(async () => {
      const real = (path: string) => NodeFs.realpath(path).catch(() => NodePath.resolve(path));
      return (await real(left)) === (await real(right));
    });

  /**
   * Whether `path` is the worktree this move made. Its `.git` file must point
   * into the recorded repository's own worktree list, at an entry named
   * after the folder (`moved-<K>`, maybe with a number git added). While
   * that repository is there, the entry must also have this move's branch
   * checked out, a branch made with its note. Null when that can't be read.
   */
  const ownsWorktree = (path: string, row: LinkMoveRow, repo: string | null) =>
    Effect.gen(function* () {
      if (row.repoRoot === null || row.branch === null) return false;
      const text = yield* Effect.promise(() =>
        NodeFs.readFile(NodePath.join(path, ".git"), "utf8").then(
          (content): string | null => content,
          (error: NodeJS.ErrnoException): string | null =>
            ["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code ?? "") ? "" : null,
        ),
      );
      if (text === null) return null;
      const pointer = /^gitdir: (.+?)\s*$/.exec(text)?.[1];
      if (pointer === undefined) return false;
      const entry = NodePath.resolve(path, pointer);
      const base = `moved-${row.transferKey.slice(0, 12)}`;
      const name = NodePath.basename(entry);
      if (!name.startsWith(base) || !/^\d*$/.test(name.slice(base.length))) return false;
      // The repository's worktree list: where its git dir is while it's
      // there, else where it was.
      let common = NodePath.join(row.repoRoot, ".git");
      if (repo !== null) {
        const found = yield* runGit(repo, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        if (!found.ok) return null;
        common = found.out;
      }
      if (!(yield* samePlace(NodePath.dirname(entry), NodePath.join(common, "worktrees")))) {
        return false;
      }
      if (repo === null) return true;
      const head = yield* Effect.promise(() =>
        NodeFs.readFile(NodePath.join(entry, "HEAD"), "utf8").then(
          (content) => content.trim(),
          () => "",
        ),
      );
      return head === `ref: refs/heads/${row.branch}` && (yield* ownsBranch(repo, row.branch, row));
    });

  /**
   * Whether any thread here works in `path`: then nothing a move does may
   * touch it. Null when that couldn't be read.
   */
  const pathInUse = (path: string) =>
    snapshots.getCommandReadModel().pipe(
      Effect.map((model): boolean | null =>
        model.threads.some(
          (thread) =>
            thread.deletedAt === null &&
            (thread.worktreePath === path || thread.effectiveCwd === path),
        ),
      ),
      Effect.orElseSucceed((): boolean | null => null),
    );

  /**
   * Ends a move here (unless it committed or ended already) and cleans up
   * after it. True when this call ended it; fails when that couldn't be
   * recorded, so nobody is told it ended. `abortCode`: this computer's user
   * said Don't allow, or nobody allowed it in time.
   */
  const abortRow = (row: LinkMoveRow, reason: string, abortCode?: PeerMoveAbortCode) =>
    Effect.gen(function* () {
      // An import that landed (its final write lost) is committed, whatever
      // asked to stop it.
      if (row.status === "importing" && (yield* importLanded(row))) {
        yield* moves
          .settle({
            linkDeviceId: row.linkDeviceId,
            transferId: row.transferId,
            status: "committed",
            now: yield* nowIso,
          })
          .pipe(Effect.mapError(() => peerFailure(`${ownLabel()} couldn't record that.`)));
        return false;
      }
      const settled = yield* moves
        .settle({
          linkDeviceId: row.linkDeviceId,
          transferId: row.transferId,
          status: "aborted",
          reason,
          ...(abortCode !== undefined ? { abortCode } : {}),
          now: yield* nowIso,
        })
        .pipe(Effect.mapError(() => peerFailure(`${ownLabel()} couldn't record that.`)));
      if (settled) {
        if (row.status === "awaiting_approval") yield* announcePending;
        yield* cleanUp({ ...row, status: "aborted", reason, abortCode: abortCode ?? null });
        // Its family's members waiting on it (Part 3f, (g)) end too, and a
        // slot it held goes to the next one: looked at once this lock is let go.
        yield* Effect.suspend(() => startImports).pipe(Effect.forkIn(scope));
      }
      return settled;
    });

  // ---------------------------------------------------------------------------
  // Offer, chunks, finish
  // ---------------------------------------------------------------------------

  const prepare: LinkMovesShape["prepare"] = (link, input) =>
    Effect.gen(function* () {
      const { manifest, transferId } = input;
      const transferKey = linkMoveKey(link.deviceId, transferId);
      return yield* lock(transferKey)(
        Effect.gen(function* () {
          const existing = yield* readRow(link.deviceId, transferId);
          if (Option.isSome(existing)) {
            const row = existing.value;
            // The same offer again (a retry): where it stands. Another one
            // under the same id is refused.
            return row.manifest.sha256 === manifest.sha256 &&
              row.manifest.totalBytes === manifest.totalBytes
              ? stateOf(row)
              : gone("That move id is taken.");
          }
          const identity = linkIdentityRefusal(link, manifest.source.environmentId);
          if (identity !== null) return gone(identity);
          const authority = yield* requests.authority(link.deviceId);
          if (!authority.ok) return gone(authority.text);
          const manifestRefusal = moveManifestRefusal(manifest);
          if (manifestRefusal !== null)
            return gone(`${ownLabel()} can't take it: ${manifestRefusal}.`);
          const land = yield* landing(manifest);
          if (land === null) return gone(`${ownLabel()} doesn't have this project.`);
          const agent = yield* requests.resolveAgentFor({
            agent: {
              instanceId: manifest.agent.instanceId,
              model: manifest.agent.model,
              ...(manifest.agent.options !== undefined ? { options: manifest.agent.options } : {}),
            },
            interactionMode: manifest.thread.interactionMode,
          });
          if ("refused" in agent) return gone(agent.refused);
          // Each room agent the sender moves here must be one of this computer's.
          const roomAgents = yield* resolveRoomAgents(manifest);
          for (const participant of manifest.thread.room?.participants ?? []) {
            const resolved = roomAgents.get(participant.id);
            if (resolved !== undefined && "refused" in resolved) {
              return gone(`${participant.handle}: ${resolved.refused}`);
            }
          }
          // A family member (Part 3f, (g)): its thread is named from the
          // family's key here, so its relatives can name it before it lands.
          // One member moves here once.
          const familyKey =
            manifest.family !== undefined
              ? linkFamilyKey(link.deviceId, manifest.family.id)
              : undefined;
          if (familyKey !== undefined) {
            const earlier = yield* moves
              .findFamilyMember(familyKey, manifest.source.threadId)
              .pipe(Effect.mapError(() => peerFailure(`${ownLabel()} couldn't read its moves.`)));
            if (Option.isSome(earlier) && earlier.value.status !== "aborted") {
              return gone("That thread is already moving here with its family.");
            }
          }
          // An asking computer that reads the codes is told why a refusal
          // came; an older one is answered exactly as before.
          const asksStaged = input.stagedApproval === true;
          const refused = (reason: string, code: PeerMoveRefusalCode) =>
            gone(reason, asksStaged ? code : undefined);
          // Counting and recording under one lock, so offers made at once
          // can't all fit under the caps. The link's access is read again
          // right before recording: one turned to Ask first meanwhile asks.
          const admitted = yield* lock("admission")(
            Effect.gen(function* () {
              const current = yield* requests.authority(link.deviceId);
              if (!current.ok) return gone(current.text);
              const held = current.access === "ask" && asksStaged;
              const open = yield* moves.listOpen;
              // A family member may wait here for its relatives holding no
              // slot (Part 3f, review change 2): it counts against the staging
              // budget from the start, as a move held for Allow does. One its
              // relatives here already wait for (their parent, or the folder
              // they share) is never refused for their waits: the member they
              // wait for can always come.
              const source = manifest.source.threadId;
              const awaited =
                familyKey !== undefined &&
                open.some(
                  (entry) =>
                    entry.familyKey === familyKey &&
                    entry.status === "waiting_for_family" &&
                    (entry.manifest.family?.parentThreadId === source ||
                      entry.manifest.family?.sharesCheckoutOf === source),
                );
              if ((held || familyKey !== undefined) && !awaited) {
                const waiting = open.filter(
                  (entry) => entry.linkDeviceId === link.deviceId && holdsStaging(entry),
                );
                const bytes = waiting.reduce((sum, entry) => sum + entry.manifest.totalBytes, 0);
                if (
                  waiting.length >= MAX_STAGED_MOVES_PER_LINK ||
                  bytes + manifest.totalBytes > MAX_STAGED_BYTES_PER_LINK
                ) {
                  return refused(
                    held
                      ? `${ownLabel()} is holding other moves until its user allows them.`
                      : `${ownLabel()} is holding as many moves as it can while their families arrive.`,
                    "staging_full",
                  );
                }
              }
              const inFlight = open.filter((entry) => !holdsNoSlot(entry));
              if (
                inFlight.filter((entry) => entry.linkDeviceId === link.deviceId).length >=
                  MAX_OPEN_MOVES_PER_LINK ||
                inFlight.length >= MAX_OPEN_MOVES
              ) {
                return refused(
                  `${ownLabel()} is already taking other moves. Try again once they're done.`,
                  "busy",
                );
              }
              return yield* moves.insert({
                linkDeviceId: link.deviceId,
                transferId,
                transferKey,
                status: current.access === "ask" ? "awaiting_approval" : "receiving",
                stagedApproval: held,
                manifest,
                threadId:
                  familyKey !== undefined
                    ? linkFamilyThreadId(familyKey, manifest.source.threadId)
                    : linkMoveThreadId(transferKey),
                familyKey,
                now: yield* nowIso,
              });
            }),
          ).pipe(Effect.mapError(() => peerFailure(`${ownLabel()} couldn't record the move.`)));
          if (!("transferKey" in admitted)) return admitted;
          if (admitted.status === "awaiting_approval") yield* announcePending;
          return stateOf(admitted);
        }),
      );
    });

  const chunk: LinkMovesShape["chunk"] = (link, input) =>
    Effect.gen(function* () {
      const data = Buffer.from(input.data, "base64");
      if (data.length === 0 || data.length > PEER_MOVE_CHUNK_MAX_BYTES) {
        return yield* new PeerRpcError({ detail: "A chunk must hold 1 byte to 1 MB." });
      }
      const transferKey = linkMoveKey(link.deviceId, input.transferId);
      // Set when the last byte of a move allowed early arrives: its import
      // starts (or waits for a slot) now, as `finish` would have started it.
      let allowedAndWhole = false;
      const answer = yield* lock(transferKey)(
        Effect.gen(function* () {
          const found = yield* readRow(link.deviceId, input.transferId);
          if (Option.isNone(found)) return gone();
          const row = found.value;
          // A move held for Allow takes its bytes now when it was offered so.
          const takes =
            row.status === "receiving" ||
            (row.status === "awaiting_approval" && row.stagedApproval);
          if (!takes || input.offset !== row.bytesReceived) return stateOf(row);
          if (input.offset + data.length > row.manifest.totalBytes) {
            return yield* new PeerRpcError({ detail: "That chunk goes past the end." });
          }
          const authority = yield* requests.authority(link.deviceId);
          if (!authority.ok) {
            yield* abortRow(row, authority.text);
            return gone(authority.text);
          }
          const written = yield* Effect.tryPromise(async () => {
            await NodeFs.mkdir(stagingDir(row), { recursive: true });
            const handle = await NodeFs.open(payloadPath(row), "a+");
            try {
              // A write cut off before its count was recorded is dropped.
              const { size } = await handle.stat();
              if (size !== row.bytesReceived) await handle.truncate(row.bytesReceived);
              await handle.write(data, 0, data.length, row.bytesReceived);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }).pipe(Effect.option);
          if (Option.isNone(written)) {
            return yield* new PeerRpcError({ detail: `${ownLabel()} couldn't save that chunk.` });
          }
          const bytesReceived = row.bytesReceived + data.length;
          const recorded = yield* moves
            .update({
              linkDeviceId: row.linkDeviceId,
              transferId: row.transferId,
              patch: { bytesReceived },
              now: yield* nowIso,
            })
            .pipe(Effect.orElseSucceed(() => false));
          // Not recorded: answered with what is, so the asking computer sends
          // the chunk again (the write past the count is dropped then), and
          // never hears "every byte is here" before that is so.
          if (!recorded) return stateOf(row);
          const next = { ...row, bytesReceived };
          // Every byte of a move sent before Allow is here: checked now, so
          // the asking computer hears of a bad copy while it can still say
          // so. Still held, the card can say it arrived; allowed already (an
          // Allow given while the bytes still came), it imports. The asking
          // computer hears `importing` and calls no finish.
          if (staged(next) || waitingToImport(next)) {
            if (!(yield* verifyPayload(next))) {
              const reason = `What arrived on ${ownLabel()} doesn't match what was sent. Try again.`;
              yield* abortRow(next, reason);
              return gone(reason);
            }
            if (staged(next)) yield* announcePending;
            else allowedAndWhole = true;
          }
          return stateOf(next);
        }),
      );
      if (allowedAndWhole) yield* startImports;
      return answer;
    });

  /** Whether the staged payload is whole: every part's hash and the payload's. */
  const verifyPayload = (row: LinkMoveRow) =>
    Effect.tryPromise(async () => {
      // Nothing to carry (a clean, pushed thread): there is no payload file.
      const bytes =
        row.manifest.totalBytes === 0 ? Buffer.alloc(0) : await NodeFs.readFile(payloadPath(row));
      if (bytes.length !== row.manifest.totalBytes) return false;
      if (createHash("sha256").update(bytes).digest("hex") !== row.manifest.sha256) return false;
      return row.manifest.parts.every(
        (part) =>
          createHash("sha256")
            .update(bytes.subarray(part.offset, part.offset + part.length))
            .digest("hex") === part.sha256,
      );
    }).pipe(Effect.orElseSucceed(() => false));

  const finish: LinkMovesShape["finish"] = (link, input) =>
    Effect.gen(function* () {
      const transferKey = linkMoveKey(link.deviceId, input.transferId);
      const answer = yield* lock(transferKey)(
        Effect.gen(function* () {
          const found = yield* readRow(link.deviceId, input.transferId);
          if (Option.isNone(found)) return gone();
          const row = found.value;
          if (row.status !== "receiving") return stateOf(row);
          if (row.bytesReceived !== row.manifest.totalBytes) return stateOf(row);
          if (!(yield* verifyPayload(row))) {
            const reason = `What arrived on ${ownLabel()} doesn't match what was sent. Try again.`;
            yield* abortRow(row, reason);
            return gone(reason);
          }
          // Sent before Allow and allowed: it imports when a slot is free.
          if (row.stagedApproval) return { queued: true as const, state: stateOf(row) };
          yield* moves
            .update({
              linkDeviceId: row.linkDeviceId,
              transferId: row.transferId,
              patch: { status: "importing" },
              now: yield* nowIso,
            })
            .pipe(Effect.ignore);
          return stateOf({ ...row, status: "importing" });
        }),
      );
      if ("queued" in answer) {
        yield* startImports;
        return answer.state;
      }
      if (answer.status === "importing") {
        yield* runImport(link.deviceId, input.transferId).pipe(Effect.forkIn(scope));
      }
      return answer;
    });

  const status: LinkMovesShape["status"] = (link, input) =>
    readRow(link.deviceId, input.transferId).pipe(
      Effect.map((found) => (Option.isSome(found) ? stateOf(found.value) : gone())),
    );

  const abort: LinkMovesShape["abort"] = (link, input) =>
    abortMove(link.deviceId, input.transferId).pipe(Effect.tap(() => startImports));

  /**
   * Records a move whose thread landed here as committed. First its worktree
   * gets the project's setup script, as a new worktree thread here would
   * (it brings ignored files like .env and installs what the worktree
   * needs): run before the record, so a crash between them repeats the
   * script rather than skipping it.
   */
  const settleLanded = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      // A general chat's folder gets no setup script: it isn't a project's
      // worktree. Nor does a family member's in another's folder: that
      // folder's own move ran it.
      if (
        row.worktreePath !== null &&
        !isScratchMoveManifest(row.manifest) &&
        row.manifest.family?.sharesCheckoutOf === undefined
      ) {
        const land = yield* landing(row.manifest);
        if (land !== null) {
          yield* setupScripts
            .runForThread({
              threadId: row.threadId,
              projectId: land.project.id,
              projectCwd: land.project.workspaceRoot,
              worktreePath: row.worktreePath,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("moved thread's setup script didn't start", {
                  threadId: row.threadId,
                  detail: error.message,
                }),
              ),
            );
        }
      }
      yield* releaseAdopted(row);
      return yield* moves.settle({
        linkDeviceId: row.linkDeviceId,
        transferId: row.transferId,
        status: "committed",
        now: yield* nowIso,
      });
    });

  /**
   * Drop a move unless it committed: answers which one it is now. Answers
   * `aborted` only once that is recorded here, and fails when anything it
   * needs to know couldn't be read, so the asking computer asks again rather
   * than unfreezing a thread that may still arrive here.
   */
  const abortMove = (
    linkDeviceId: string,
    transferId: string,
    reason?: string,
    abortCode?: PeerMoveAbortCode,
  ) =>
    lock(linkMoveKey(linkDeviceId, transferId))(
      Effect.gen(function* () {
        const found = yield* readRow(linkDeviceId, transferId);
        // Never offered here: nothing can arrive without the bytes the asking
        // computer stops sending.
        if (Option.isNone(found)) return gone(reason);
        const row = found.value;
        if (row.status === "committed" || row.status === "aborted") return stateOf(row);
        // The import may have created the thread before it recorded so.
        if (yield* importLanded(row)) {
          yield* settleLanded(row).pipe(
            Effect.mapError(() => peerFailure(`${ownLabel()} couldn't record that.`)),
          );
          yield* arrive(row);
          return stateOf({ ...row, status: "committed" });
        }
        const why = reason ?? "The move was cancelled.";
        if (!(yield* abortRow(row, why, abortCode))) {
          const now = yield* readRow(linkDeviceId, transferId);
          return Option.isSome(now) ? stateOf(now.value) : gone(why);
        }
        return stateOf({ ...row, status: "aborted", reason: why, abortCode: abortCode ?? null });
      }),
    );

  // ---------------------------------------------------------------------------
  // The import
  // ---------------------------------------------------------------------------

  /** One stage of an import, under the transfer's lock; null when the move is no longer importing. */
  const stage = <A>(
    linkDeviceId: string,
    transferId: string,
    run: (row: LinkMoveRow) => Effect.Effect<A, ImportStop | PeerRpcError>,
  ) =>
    lock(linkMoveKey(linkDeviceId, transferId))(
      Effect.gen(function* () {
        const found = yield* readRow(linkDeviceId, transferId);
        if (Option.isNone(found) || found.value.status !== "importing") return null;
        const authority = yield* requests.authority(linkDeviceId);
        if (!authority.ok) return yield* new ImportStop({ reason: authority.text });
        return { value: yield* run(found.value) };
      }),
    );

  const setStage = (row: LinkMoveRow, patch: Parameters<typeof moves.update>[0]["patch"]) =>
    Effect.gen(function* () {
      yield* moves
        .update({
          linkDeviceId: row.linkDeviceId,
          transferId: row.transferId,
          patch,
          now: yield* nowIso,
        })
        .pipe(
          Effect.mapError(
            () => new ImportStop({ reason: `${ownLabel()} couldn't record its progress.` }),
          ),
        );
    });

  const stop = (reason: string) => Effect.fail(new ImportStop({ reason }));

  /** Whether a member's folder is made here: its owner's move applied its files, or landed. */
  const folderMade = (owner: LinkMoveRow) =>
    owner.status === "committed" || owner.stage === "applied" || owner.stage === "arrived";

  /**
   * Where a family member's import stands against its relatives (docs/design/
   * fleet.md, Part 3f, review change 3). First folders: a member in another's
   * folder waits only until that folder is made here, in no order among
   * folders, so a parent working in its child's folder can't wait on itself.
   * Then threads: a child commits only once its parent has. `stop` when the
   * one it waits for was dropped; `wait` while it may still come.
   */
  const familyGate = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const family = row.manifest.family;
      const key = row.familyKey;
      if (family === undefined || key === null) return { kind: "ready" } as const;
      const member = (sourceThreadId: string) =>
        moves
          .findFamilyMember(key, sourceThreadId)
          .pipe(Effect.mapError(() => peerFailure(`${ownLabel()} couldn't read its moves.`)));
      // A member in another's folder, at any stage before it lands: the
      // folder's owner must still be coming, and own a folder of its own (a
      // sharer can't be one's owner). One dropped meanwhile ends it, never
      // leaves it pointing at a folder nobody moved.
      if (family.sharesCheckoutOf !== undefined) {
        const owner = yield* member(family.sharesCheckoutOf);
        if (Option.isNone(owner)) {
          if (row.stage === null) return { kind: "wait" } as const;
          return { kind: "stop", reason: OWNER_DIDNT_MOVE } as const;
        }
        if (
          owner.value.status === "aborted" ||
          owner.value.manifest.family?.sharesCheckoutOf !== undefined
        ) {
          return { kind: "stop", reason: OWNER_DIDNT_MOVE } as const;
        }
        if (!sameProjectAs(owner.value.manifest, row.manifest)) {
          return { kind: "stop", reason: OTHER_PROJECTS_FOLDER } as const;
        }
        if (row.stage === null) {
          return folderMade(owner.value)
            ? ({ kind: "ready" } as const)
            : ({ kind: "wait" } as const);
        }
      }
      if (row.stage === "applied" && family.parentThreadId !== undefined) {
        const parent = yield* member(family.parentThreadId);
        if (Option.isNone(parent)) return { kind: "wait" } as const;
        if (parent.value.status === "aborted") {
          return { kind: "stop", reason: PARENT_DIDNT_MOVE } as const;
        }
        return parent.value.status === "committed"
          ? ({ kind: "ready" } as const)
          : ({ kind: "wait" } as const);
      }
      return { kind: "ready" } as const;
    });

  /**
   * A member in another's folder skips the git stages: once that folder is
   * made here it goes straight to its commit, where it takes the folder.
   */
  const sharerStage = (row: LinkMoveRow) => setStage(row, { stage: "applied" });

  const partBytes = (row: LinkMoveRow, part: PeerMovePart) =>
    Effect.tryPromise(async () => {
      // An empty file: nothing to read (a payload of only those has no file).
      if (part.length === 0) return Buffer.alloc(0);
      const handle = await NodeFs.open(payloadPath(row), "r");
      try {
        const buffer = Buffer.alloc(part.length);
        await handle.read(buffer, 0, part.length, part.offset);
        return buffer;
      } finally {
        await handle.close();
      }
    }).pipe(
      Effect.mapError(() => new ImportStop({ reason: `${ownLabel()} lost the move's data.` })),
    );

  /** Fetches the remote, and takes the bundle's commits into a ref named from the move. */
  const fetchStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const land = yield* landing(row.manifest);
      if (land === null) return yield* stop(`${ownLabel()} doesn't have this project anymore.`);
      // The repository's top level (the project may be a folder inside it),
      // recorded before anything is made in it, so clean-up finds it even if
      // the project goes.
      const top = yield* runGit(land.root, ["rev-parse", "--show-toplevel"]);
      if (!top.ok) return yield* stop(`${ownLabel()} can't read this project's repository.`);
      yield* setStage(row, { repoRoot: top.out });
      yield* runGit(land.root, ["fetch", "--quiet", land.remoteName], GIT_FETCH_TIMEOUT_MS);
      const bundle = row.manifest.parts.find((part) => part.kind === "bundle");
      const moved = gitOf(row.manifest);
      if (moved === null) return yield* stop(`${ownLabel()} lost track of the move.`);
      const { headSha, baseSha } = moved;
      if (bundle !== undefined && baseSha === null) {
        return yield* stop(`${ownLabel()} can't take commits that start from nothing.`);
      }
      if (bundle !== undefined) {
        const bundlePath = NodePath.join(stagingDir(row), "commits.bundle");
        const bytes = yield* partBytes(row, bundle);
        yield* Effect.tryPromise(() => NodeFs.writeFile(bundlePath, bytes)).pipe(
          Effect.mapError(
            () => new ImportStop({ reason: `${ownLabel()} couldn't unpack the commits.` }),
          ),
        );
        const verified = yield* runGit(land.root, ["bundle", "verify", "--quiet", bundlePath]);
        if (!verified.ok) {
          return yield* stop(
            `${ownLabel()} can't find commit ${(baseSha ?? "").slice(0, 7)} on ${land.remoteName}. Push it, or fetch on ${ownLabel()}, then try again.`,
          );
        }
        const fetched = yield* runGit(
          land.root,
          [
            "-c",
            "transfer.fsckObjects=true",
            "fetch",
            "--quiet",
            bundlePath,
            `refs/threadlines/move/${row.transferId}:${tempRef(row)}`,
          ],
          GIT_FETCH_TIMEOUT_MS,
        );
        if (!fetched.ok) return yield* stop(`${ownLabel()} couldn't take the commits.`);
      }
      const has = yield* runGit(land.root, ["cat-file", "-e", `${headSha}^{commit}`]);
      if (!has.ok) {
        return yield* stop(
          `${ownLabel()} can't find commit ${headSha.slice(0, 7)} on ${land.remoteName}. Push it, or fetch on ${ownLabel()}, then try again.`,
        );
      }
      // Measured before anything is checked out or written.
      const written = yield* expansionBytes(row, land.root);
      if (written === null || written > MOVE_MAX_EXPANDED_BYTES) {
        return yield* stop(`It's too big for ${ownLabel()} to unpack.`);
      }
      yield* setStage(row, { stage: "fetched" });
    });

  /**
   * How many bytes checking out `head` writes beyond `base`: every path the
   * commits change, at its new size, so one blob under many paths counts
   * each time. Null when that can't be read.
   */
  const checkoutBytes = (root: string, base: string, head: string) =>
    Effect.gen(function* () {
      const changed = yield* git
        .execute({
          operation: "LinkMoves.sizeCheckout",
          cwd: root,
          args: ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", base, head],
          allowNonZeroExit: true,
          timeoutMs: GIT_TIMEOUT_MS,
          maxOutputBytes: 64_000_000,
        })
        .pipe(Effect.option);
      if (Option.isNone(changed) || changed.value.exitCode !== 0 || changed.value.stdoutTruncated) {
        return null;
      }
      // `:<old mode> <new mode> <old id> <new id> <status>` then the path.
      const fields = changed.value.stdout.split("\0");
      const ids: Array<string> = [];
      for (let index = 0; index + 1 < fields.length; index += 2) {
        const [, newMode, , newId] = fields[index]!.split(" ");
        if (newMode === undefined || newId === undefined) continue;
        // Gone (nothing written) or a submodule (an empty folder).
        if (/^0+$/.test(newMode) || newMode === "160000") continue;
        ids.push(newId);
      }
      if (ids.length === 0) return 0;
      const sized = yield* git
        .execute({
          operation: "LinkMoves.sizeCheckout",
          cwd: root,
          args: ["cat-file", "--batch-check=%(objectsize)"],
          stdin: `${ids.join("\n")}\n`,
          allowNonZeroExit: true,
          timeoutMs: GIT_TIMEOUT_MS,
          maxOutputBytes: 64_000_000,
        })
        .pipe(Effect.option);
      if (Option.isNone(sized) || sized.value.exitCode !== 0) return null;
      const sizes = sized.value.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => Number.parseInt(line, 10));
      if (sizes.length !== ids.length || sizes.some((size) => !Number.isFinite(size))) return null;
      return sizes.reduce((sum, size) => sum + size, 0);
    });

  /**
   * Everything the move writes here beyond the project as its remote has it:
   * its commits' changed files, its binary changes unpacked, its patch and
   * new files. Null when any of it can't be measured.
   */
  const expansionBytes = (row: LinkMoveRow, root: string) =>
    Effect.gen(function* () {
      const moved = gitOf(row.manifest);
      if (moved === null) return null;
      const { headSha, baseSha } = moved;
      const committed =
        baseSha === null || !row.manifest.parts.some((part) => part.kind === "bundle")
          ? 0
          : yield* checkoutBytes(root, baseSha, headSha);
      if (committed === null) return null;
      const diff = row.manifest.parts.find((part) => part.kind === "diff");
      const patch =
        diff === undefined || diff.length === 0
          ? 0
          : binaryPatchBytes((yield* partBytes(row, diff)).toString("latin1"));
      if (patch === null) return null;
      const files = row.manifest.parts
        .filter((part) => part.kind === "file" || part.kind === "diff")
        .reduce((sum, part) => sum + part.length, 0);
      return committed + patch + files;
    });

  /** The branch name the move takes here: its own, else one marked with where it came from. */
  const pickBranch = (root: string, row: LinkMoveRow) =>
    Effect.gen(function* () {
      const source = gitOf(row.manifest)?.branch ?? null;
      const from = row.manifest.source.environmentLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      const slug =
        row.manifest.thread.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "thread";
      const valid = (name: string) =>
        runGit(root, ["check-ref-format", "--branch", name]).pipe(
          Effect.map((result) => result.ok),
        );
      const taken = (name: string) =>
        runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).pipe(
          Effect.map((result) => result.ok),
        );
      const base =
        source !== null && (yield* valid(source))
          ? [source, `${source}-from-${from || "elsewhere"}`]
          : [`moved/${slug}`];
      const candidates = [...base];
      for (let suffix = 2; suffix <= 100; suffix += 1) candidates.push(`${base.at(-1)}-${suffix}`);
      for (const name of candidates) {
        if ((yield* valid(name)) && !(yield* taken(name))) return name;
      }
      return yield* stop(`${ownLabel()} couldn't find a free branch name.`);
    });

  /** The worktree the moved thread works in, at the moved commit, named from the move. */
  const worktreeStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const land = yield* landing(row.manifest);
      if (land === null) return yield* stop(`${ownLabel()} doesn't have this project anymore.`);
      const moved = gitOf(row.manifest);
      if (moved === null) return yield* stop(`${ownLabel()} lost track of the move.`);
      const { headSha } = moved;
      const branch = row.branch ?? (yield* pickBranch(land.root, row));
      const path =
        row.worktreePath ??
        NodePath.join(
          config.worktreesDir,
          NodePath.basename(row.repoRoot ?? land.root),
          `moved-${row.transferKey.slice(0, 12)}`,
        );
      // A folder already there when the move first picks its path isn't its
      // own: it's never adopted, reset or removed.
      if (row.worktreePath === null && (yield* pathState(path)) !== false) {
        return yield* stop(`${ownLabel()} already has a folder at ${path}.`);
      }
      // Recorded before it is made, so a restart finds what it owns.
      yield* setStage(row, { branch, worktreePath: path });
      const listed = yield* runGit(land.root, ["worktree", "list", "--porcelain"]);
      // git lists real paths (macOS's /var is /private/var).
      const real = yield* Effect.promise(() => NodeFs.realpath(path).catch(() => path));
      const registered = listed.out
        .split("\n")
        .some((line) => line === `worktree ${path}` || line === `worktree ${real}`);
      if (registered) {
        // Only the worktree this move made is kept or replaced; another one
        // at its path (made after a crash) stops the move instead.
        if ((yield* ownsWorktree(path, row, row.repoRoot)) !== true) {
          return yield* stop(`${ownLabel()} has another worktree at ${path}.`);
        }
        const head = yield* runGit(path, ["rev-parse", "HEAD"]);
        if (head.ok && head.out === headSha) {
          if (row.branch !== null) yield* trackUpstream(land, row, row.branch);
          yield* setStage(row, { stage: "worktree" });
          return;
        }
        if ((yield* pathInUse(path)) !== false) {
          return yield* stop(`A thread on ${ownLabel()} is using that folder.`);
        }
        yield* runGit(land.root, ["worktree", "remove", "--force", path]);
      }
      // The saved name is ours only if this move made it (a restart after
      // making it); one taken by anyone else since gets another name. Made
      // with this move's note, so clean-up knows which branch to delete.
      let name = branch;
      if (!(yield* ownsBranch(land.root, name, row))) {
        const make = (candidate: string) =>
          runGit(land.root, [
            "update-ref",
            "--create-reflog",
            "-m",
            branchNote(row),
            `refs/heads/${candidate}`,
            headSha,
            "",
          ]);
        if (!(yield* make(name)).ok) {
          name = yield* pickBranch(land.root, row);
          yield* setStage(row, { branch: name });
          if (!(yield* make(name)).ok) {
            return yield* stop(`${ownLabel()} couldn't make a branch for it.`);
          }
        }
      }
      const created = yield* runGit(land.root, ["worktree", "add", path, name]);
      if (!created.ok) return yield* stop(`${ownLabel()} couldn't make a worktree for it.`);
      const head = yield* runGit(path, ["rev-parse", "HEAD"]);
      if (!head.ok || head.out !== headSha) {
        return yield* stop(`${ownLabel()}'s worktree for it isn't at the moved commit.`);
      }
      yield* runGit(land.root, ["update-ref", "-d", tempRef(row)]);
      yield* trackUpstream(land, row, name);
      yield* setStage(row, { stage: "worktree" });
    });

  /**
   * The branch made here tracks the branch it tracked there, when the remote
   * has it (docs/design/fleet.md, Part 3e, (c)): the thread's own pull
   * request is found by it, and a merge waits for commits not pushed to it.
   * For every move, whatever its switches. Best effort: a branch left without
   * one says so at the commit (`upstreamOf`).
   */
  const trackUpstream = (
    land: { readonly root: string; readonly remoteName: string },
    row: LinkMoveRow,
    branch: string,
  ) =>
    Effect.gen(function* () {
      const upstream = gitOf(row.manifest)?.upstreamBranch;
      if (upstream === undefined || land.remoteName.length === 0) return;
      const remoteRef = `refs/remotes/${land.remoteName}/${upstream}`;
      const there = yield* runGit(land.root, ["rev-parse", "--verify", "--quiet", remoteRef]);
      if (!there.ok) return;
      yield* runGit(land.root, ["config", `branch.${branch}.remote`, land.remoteName]);
      yield* runGit(land.root, ["config", `branch.${branch}.merge`, `refs/heads/${upstream}`]);
    });

  /** The upstream the moved thread's branch tracks here (`<remote>/<branch>`), or null. */
  const upstreamOf = (root: string, branch: string) =>
    runGit(root, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${branch}@{upstream}`,
    ]).pipe(Effect.map((result) => (result.ok && result.out.length > 0 ? result.out : null)));

  /** Writes one new file, refusing any parent that is a symbolic link. */
  const writeNewFile = (root: string, part: PeerMovePart, bytes: Buffer) =>
    Effect.tryPromise(() =>
      writeReceivedFile(
        root,
        part.path!,
        part.mode === "symlink"
          ? { symlinkTarget: bytes.toString("utf8") }
          : { bytes, mode: part.mode === "executable" ? 0o755 : 0o644 },
      ),
    ).pipe(
      Effect.mapError(
        () => new ImportStop({ reason: `${ownLabel()} couldn't write ${part.path} safely.` }),
      ),
    );

  /** The changes and new files, in the move's own worktree. A crashed apply starts again clean. */
  const applyStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const path = row.worktreePath;
      if (path === null) return yield* stop(`${ownLabel()} lost track of the move's worktree.`);
      const moved = gitOf(row.manifest);
      if (moved === null) return yield* stop(`${ownLabel()} lost track of the move.`);
      const { headSha } = moved;
      const status = yield* runGit(path, ["status", "--porcelain"]);
      if (status.out.length > 0) {
        // Ours, uncommitted, never handed to a thread: back to the moved commit.
        if (
          (yield* pathInUse(path)) !== false ||
          (yield* ownsWorktree(path, row, row.repoRoot)) !== true
        ) {
          return yield* stop(`A thread on ${ownLabel()} is using that folder.`);
        }
        yield* runGit(path, ["reset", "--hard", headSha]);
        yield* runGit(path, ["clean", "-fdx"]);
      }
      const diff = row.manifest.parts.find((part) => part.kind === "diff");
      const files = row.manifest.parts.filter((part) => part.kind === "file");
      // Its size was measured before the worktree was made (expansionBytes).
      const diffBytes = diff !== undefined && diff.length > 0 ? yield* partBytes(row, diff) : null;
      if (diffBytes !== null) {
        const diffPath = NodePath.join(stagingDir(row), "changes.diff");
        const bytes = diffBytes;
        yield* Effect.tryPromise(() => NodeFs.writeFile(diffPath, bytes)).pipe(
          Effect.mapError(
            () => new ImportStop({ reason: `${ownLabel()} couldn't unpack the changes.` }),
          ),
        );
        const applied = yield* runGit(path, ["apply", "--binary", "--whitespace=nowarn", diffPath]);
        if (!applied.ok) return yield* stop(`${ownLabel()} couldn't apply the changes.`);
      }
      if (files.length > 0) {
        const tracked = yield* runGit(path, ["ls-files", "-z"]);
        const trackedFolded = new Set(
          tracked.out
            .split("\0")
            .filter((entry) => entry.length > 0)
            .map(foldCase),
        );
        for (const part of files) {
          const refusal = movePathRefusal(part.path ?? "");
          if (refusal !== null) return yield* stop(`${ownLabel()} can't take it: ${refusal}.`);
          if (trackedFolded.has(foldCase(part.path!))) {
            return yield* stop(`"${part.path}" clashes with a file ${ownLabel()} already tracks.`);
          }
          yield* writeNewFile(path, part, yield* partBytes(row, part));
        }
      }
      yield* setStage(row, { stage: "applied" });
    });

  /**
   * A general chat's own folder in General chats here (docs/design/fleet.md,
   * Part 3e, (d)), named from the move's thread: recorded before it is made,
   * then made with an exclusive mkdir, so a folder already there that holds
   * anything stops the move rather than being written into.
   */
  const folderStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const land = yield* landing(row.manifest);
      if (land === null) return yield* stop(`${ownLabel()} has no General chats to put it in.`);
      const folder = row.worktreePath ?? scratchFolderOf(land.root, row);
      const firstTime = row.worktreePath === null;
      // One there with anything in it before this move picked it isn't its
      // own: the move stops before it is on record, so clean-up never touches it.
      if (firstTime) {
        const held = yield* Effect.promise(() =>
          NodeFs.readdir(folder).then(
            (entries) => entries.length > 0,
            (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
          ),
        );
        if (held) return yield* stop(`${ownLabel()} already has a folder at ${folder}.`);
        yield* setStage(row, { worktreePath: folder });
      }
      const made = yield* Effect.tryPromise(async () => {
        await NodeFs.mkdir(NodePath.dirname(folder), { recursive: true });
        try {
          await NodeFs.mkdir(folder);
          return "made" as const;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return (await NodeFs.readdir(folder)).length === 0
            ? ("empty" as const)
            : ("full" as const);
        }
      }).pipe(
        Effect.mapError(
          () => new ImportStop({ reason: `${ownLabel()} couldn't make a folder for this chat.` }),
        ),
      );
      // One there before this move picked it isn't its own.
      if (made === "full" && firstTime) {
        return yield* stop(`${ownLabel()} already has a folder at ${folder}.`);
      }
      yield* setStage(row, { stage: "folder" });
    });

  /** A general chat's files, into its folder. A crashed write starts again in an emptied folder. */
  const scratchApplyStage = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const folder = row.worktreePath;
      if (folder === null) return yield* stop(`${ownLabel()} lost track of the chat's folder.`);
      const entries = yield* Effect.tryPromise(() => NodeFs.readdir(folder)).pipe(
        Effect.mapError(() => new ImportStop({ reason: `${ownLabel()} lost the chat's folder.` })),
      );
      if (entries.length > 0) {
        if ((yield* ownsScratchFolder(row, folder)) !== true) {
          return yield* stop(`A thread on ${ownLabel()} is using that folder.`);
        }
        yield* Effect.tryPromise(async () => {
          await NodeFs.rm(folder, { recursive: true, force: true });
          await NodeFs.mkdir(folder);
        }).pipe(
          Effect.mapError(
            () => new ImportStop({ reason: `${ownLabel()} couldn't empty the chat's folder.` }),
          ),
        );
      }
      for (const part of row.manifest.parts.filter((entry) => entry.kind === "file")) {
        const refusal = movePathRefusal(part.path ?? "");
        if (refusal !== null) return yield* stop(`${ownLabel()} can't take it: ${refusal}.`);
        yield* writeNewFile(folder, part, yield* partBytes(row, part));
      }
      yield* setStage(row, { stage: "applied" });
    });

  /** What each room agent the sender moves here (one with `agent`) resolves to on this computer. */
  const resolveRoomAgents = (manifest: PeerMoveManifest) =>
    Effect.gen(function* () {
      const resolved = new Map<string, RoomAgentResolution>();
      for (const participant of manifest.thread.room?.participants ?? []) {
        const agent = participant.agent;
        if (agent === undefined) continue;
        resolved.set(
          participant.id,
          yield* requests.resolveAgentFor({
            agent: {
              instanceId: agent.instanceId,
              model: agent.model,
              ...(agent.options !== undefined ? { options: agent.options } : {}),
            },
            interactionMode: manifest.thread.interactionMode,
          }),
        );
      }
      return resolved;
    });

  /** The new attachment a moved one becomes here: an id of this thread, written beside the others. */
  const importAttachments = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const segment = toSafeThreadAttachmentSegment(row.threadId);
      const remapped = new Map<string, ChatAttachment>();
      if (segment === null) return remapped;
      const byOldId = new Map(
        row.manifest.parts
          .filter((part) => part.kind === "attachment")
          .map((part) => [part.attachmentId!, part] as const),
      );
      // The history's, and the queued messages' (docs/design/fleet.md, Part 3e, (e)).
      const carriers = [
        ...row.manifest.thread.messages,
        ...(row.manifest.thread.state?.queuedFollowUps ?? []),
      ];
      for (const message of carriers) {
        for (const attachment of message.attachments ?? []) {
          if (remapped.has(attachment.id)) continue;
          const id = `${segment}-${derivedUuid("link-move-attachment", row.transferKey, attachment.id)}`;
          const next = { ...attachment, id } as ChatAttachment;
          const part = byOldId.get(attachment.id);
          const target = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: next,
          });
          if (part !== undefined && target !== null) {
            const bytes = yield* partBytes(row, part);
            yield* Effect.tryPromise(async () => {
              await NodeFs.mkdir(NodePath.dirname(target), { recursive: true });
              await NodeFs.writeFile(target, bytes);
            }).pipe(
              Effect.mapError(
                () => new ImportStop({ reason: `${ownLabel()} couldn't save an attachment.` }),
              ),
            );
          }
          // An attachment that didn't travel keeps its name; its bytes are just missing.
          remapped.set(attachment.id, next);
        }
      }
      return remapped;
    });

  /**
   * The moved thread's agent session, into the chosen agent's own home, and
   * the thread's binding to it (docs/design/fleet.md, Part 3d): true when
   * its first start will resume it. Only an agent of the driver that wrote
   * it takes it; anything that can't be placed leaves the thread to its
   * summary, never the move undone. Runs in the commit step, under the
   * transfer's lock, before the thread exists: a crash in between is redone
   * by the import's recovery, and the files are named from the session id,
   * so a retry finds its own.
   */
  /** Where a carried session's written files are kept on record, in the move's staging. */
  const carriedRecordPath = (row: Pick<LinkMoveRow, "transferKey">) =>
    NodePath.join(stagingDir(row), "carried-session.json");

  /**
   * Adds files a carried session writes to the record (a room carries one per
   * agent, all on one record): only ever added to, so every file any of them
   * may have written is taken back by an abort.
   */
  const writeCarriedRecord = (row: LinkMoveRow, written: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const earlier = (yield* readCarriedRecord(row)) ?? [];
      yield* Effect.tryPromise(async () => {
        await NodeFs.mkdir(stagingDir(row), { recursive: true });
        await NodeFs.writeFile(
          carriedRecordPath(row),
          JSON.stringify({ written: [...new Set([...earlier, ...written])] }),
        );
      });
    });

  /** Every binding a move's carried sessions may have written: the thread's own agent's and each room agent's. */
  const carriedBindingKeys = (row: LinkMoveRow) => [
    row.threadId,
    ...(row.manifest.thread.room?.participants ?? [])
      .filter((participant) => participant.session !== undefined)
      .map((participant) =>
        participantSessionKey(row.threadId, movedParticipantId(row.transferKey, participant.id)),
      ),
  ];

  /** The files a carried session wrote, as on record; none when it carried none. */
  const readCarriedRecord = (row: Pick<LinkMoveRow, "transferKey">) =>
    Effect.promise(async (): Promise<ReadonlyArray<string> | null> => {
      try {
        const parsed: unknown = JSON.parse(await NodeFs.readFile(carriedRecordPath(row), "utf8"));
        const written = (parsed as { written?: unknown } | null)?.written;
        return Array.isArray(written) && written.every((entry) => typeof entry === "string")
          ? written
          : null;
      } catch {
        return null;
      }
    });

  /**
   * Takes back a carried session of a move that didn't land: the files it
   * wrote (only where its own marker still matches) and its binding. True
   * once nothing of it is left; the record stays until then.
   */
  const discardCarried = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const written = yield* readCarriedRecord(row);
      if (written === null) return true;
      const gone = yield* discardSessionFiles(written, row.transferKey);
      const unbound = (yield* Effect.forEach(carriedBindingKeys(row), (key) =>
        providers.forgetNativeSession(key).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      )).every(Boolean);
      if (!gone || !unbound) return false;
      yield* Effect.promise(() => NodeFs.rm(carriedRecordPath(row), { force: true }));
      return true;
    });

  /**
   * One carried session: the thread's own agent's (`participantId` absent),
   * or a room agent's (its id in the manifest), bound to `bindingKey`, the
   * session key it runs under here.
   */
  const carrySession = (
    row: LinkMoveRow,
    carried: {
      readonly session: PeerMoveSession | undefined;
      readonly participantId?: string | undefined;
      readonly bindingKey: ThreadId;
    },
    instanceId: ProviderInstanceId,
    runtimeMode: RuntimeMode,
  ) =>
    Effect.gen(function* () {
      const session = carried.session;
      const worktreePath = row.worktreePath;
      if (session === undefined || worktreePath === null) return false;
      const info = yield* providers.getInstanceInfo(instanceId).pipe(Effect.option);
      if (Option.isNone(info) || info.value.driverKind !== session.driver) return false;
      const files = yield* Effect.forEach(
        row.manifest.parts.filter(
          (part) => part.kind === "session" && part.participantId === carried.participantId,
        ),
        (part) =>
          partBytes(row, part).pipe(Effect.map((bytes) => ({ relPath: part.path ?? "", bytes }))),
      );
      const imported = yield* providers.importNativeSession({
        instanceId,
        cursor: session.cursor,
        files,
        worktreePath,
        transferKey: row.transferKey,
        // On record before any file is written, so an abort after a crash
        // partway still finds them (discardCarried only touches its own).
        journal: (destinations) => Effect.runPromise(writeCarriedRecord(row, destinations)),
      });
      if ("refused" in imported) {
        yield* Effect.logWarning("link move carried no agent session", {
          transferId: row.transferId,
          reason: imported.refused,
        });
        return false;
      }
      // Narrowed to what it really wrote, still before the binding, so an
      // abort from here on (cleanUp) takes back the files and the binding.
      yield* writeCarriedRecord(row, imported.written);
      const adopted = yield* providers
        .adoptNativeSession({
          threadId: carried.bindingKey,
          instanceId,
          cursor: imported.cursor,
          runtimeMode,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(adopted)) {
        // Only this session's files: another agent's stay carried.
        yield* discardSessionFiles(imported.written, row.transferKey);
        return yield* Effect.failCause(adopted.cause);
      }
      return true;
    }).pipe(
      // Not carried is the summary, never a failed move.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("link move couldn't carry the agent session", {
              transferId: row.transferId,
              cause,
            }).pipe(Effect.as(false)),
      ),
    );

  /**
   * A family member as it lands here (docs/design/fleet.md, Part 3f, (g)),
   * every id named from the family's key, which this computer derived from
   * the link it came over: requests and reports between members, the folder
   * it shares (its guest marker, from the family, never a path the other
   * computer named), the parent it lands under, and the "Moved here" words
   * for what stayed. Null for a thread that moves on its own.
   */
  const familyOf = (row: LinkMoveRow) => {
    const family = row.manifest.family;
    const key = row.familyKey;
    if (family === undefined || key === null) return null;
    const threadHere = (id: string) => linkFamilyThreadId(key, id);
    const plural = (count: number) => (count === 1 ? "1 thread" : `${count} threads`);
    const titles = (list: ReadonlyArray<{ readonly title: string }>) =>
      list.map((entry) => entry.title).join(", ");
    return {
      fromThread: (origin: NonNullable<ThreadImportMessage["fromThread"]>) => ({
        threadId: threadHere(origin.threadId),
        requestId: ChildRequestId.make(derivedUuid("link-move-request", key, origin.requestId)),
        kind: origin.kind,
      }),
      worktreeOrigin:
        family.sharesCheckoutOf !== undefined
          ? { kind: "thread" as const, threadId: threadHere(family.sharesCheckoutOf) }
          : undefined,
      /** The parent a child lands under, or why it lands as its own thread. */
      lineage: (projectId: string) =>
        Effect.gen(function* () {
          if (family.parentThreadId === undefined) return null;
          const parentId = threadHere(family.parentThreadId);
          const found = yield* threadRows
            .getById({ threadId: parentId })
            .pipe(
              Effect.mapError(
                () => new ImportStop({ reason: `${ownLabel()} couldn't read its threads.` }),
              ),
            );
          const parent = Option.getOrUndefined(found);
          const own = (why: string): FamilyLanding => ({
            left: `${why}, so this is its own thread.`,
          });
          if (parent === undefined || parent.deletedAt !== null) {
            return own("The thread that started it isn't on this computer anymore");
          }
          if ((parent.move ?? null) !== null || (parent.pendingMove ?? null) !== null) {
            return own("The thread that started it is moving on from this computer");
          }
          if (parent.projectId !== projectId) {
            return own("The thread that started it is in another project here");
          }
          return {
            lineage: {
              parentThreadId: parentId,
              parentTurnId:
                family.parentTurnId !== undefined
                  ? linkMoveTurnId(row, family.parentThreadId, family.parentTurnId)
                  : null,
            },
          } satisfies FamilyLanding;
        }),
      /** The "Moved here" words for what of its family didn't come. */
      left: (
        fromLabel: string,
        lineageLeft: string | null,
        // Named as already here instead (threadsStartedHere): an older
        // computer still lists them as staying where they are.
        alreadyHere: ReadonlySet<string>,
      ) => {
        const words: string[] = [];
        if (lineageLeft !== null) words.push(lineageLeft);
        const stayed = family.stayed ?? [];
        if (stayed.length > 0) {
          words.push(
            `${plural(stayed.length)} it started stayed on ${fromLabel}: ${titles(stayed)}.`,
          );
        }
        const byComputer = new Map<string, Array<{ readonly title: string }>>();
        for (const entry of (family.remoteStayed ?? []).filter(
          (stayed) => !alreadyHere.has(stayed.title),
        )) {
          byComputer.set(entry.label, [...(byComputer.get(entry.label) ?? []), entry]);
        }
        for (const [label, list] of byComputer) {
          words.push(
            `${plural(list.length)} it started on ${label} stayed there: ${titles(list)}. It can't reach ${list.length === 1 ? "it" : "them"} from here.`,
          );
        }
        const stopped = family.childRequestsStopped ?? 0;
        if (stopped > 0) {
          words.push(
            `It was waiting on ${plural(stopped)} it started. ${stopped === 1 ? "It was" : "They were"} stopped for the move.`,
          );
        }
        return words;
      },
    };
  };

  /**
   * How a thread moving across the link its work came over lands here
   * (docs/design/fleet.md, Part 3f, (h)), decided from this computer's own
   * link and records alone; the manifest only says which thread it means.
   *
   * - A child that moved without its parent (`remoteParent`) stays that
   *   parent's child across the link: its `remoteOrigin` is this link, and
   *   the computer this link was made for. A link that can't prove which
   *   computer that is lands it as its own thread.
   * - A thread coming home (`home`) lands under the parent here only when
   *   that parent holds exactly this thread, on exactly the computer this
   *   link was made for, as its child: a linked computer can never put a
   *   thread under one of this computer's own. Or when it came back before
   *   this computer heard its move there landed: the thread it moved over
   *   from (`fromThreadId`) is still that parent's child here, moving alone
   *   to exactly that computer, so it lands under the parent and that move
   *   completes (`completesMoveOf`).
   *
   * Anything else lands as a thread of its own, with the "Moved here" words
   * saying why (`left`).
   */
  const linkLanding = (
    row: LinkMoveRow,
    projectId: string,
    pinnedEnvironmentId: string | null,
    fromLabel: string,
  ) =>
    Effect.gen(function* () {
      const lineage = row.manifest.linkLineage;
      if (lineage === undefined || row.familyKey !== null) return {};
      const source = row.manifest.source;
      // The computer this link was made for, and the one the move says it came from.
      const home =
        pinnedEnvironmentId !== null && pinnedEnvironmentId === source.environmentId
          ? EnvironmentId.make(pinnedEnvironmentId)
          : null;
      const remoteParent = lineage.remoteParent;
      if (remoteParent !== undefined) {
        if (home === null) {
          return {
            left: `This computer can't confirm its link to ${fromLabel}, so this is its own thread and '${remoteParent.title}' there can't reach it.`,
          };
        }
        const remoteOrigin: ThreadRemoteOrigin = {
          linkDeviceId: row.linkDeviceId,
          environmentId: home,
          environmentPinned: true,
          environmentLabel: fromLabel,
          threadId: remoteParent.threadId,
          threadTitle: remoteParent.title,
        };
        return { remoteOrigin };
      }
      const parentThreadId = lineage.home?.parentThreadId;
      if (parentThreadId === undefined) return {};
      const own = {
        left: "The thread that started it isn't on this computer anymore, so this is its own thread.",
      };
      if (home === null) return own;
      const read = (threadId: ThreadId) =>
        threadRows.getById({ threadId }).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            () => new ImportStop({ reason: `${ownLabel()} couldn't read its threads.` }),
          ),
        );
      // The thread it moved over from first, then the parent: its move's
      // answer lands on both in one decision, so a parent read after a
      // move that still waited either still waits or already holds it.
      const fromThreadId = lineage.home?.fromThreadId;
      const left = fromThreadId === undefined ? undefined : yield* read(fromThreadId);
      const awaiting =
        left !== undefined &&
        awaitsLoneMoveAnswer(
          {
            deletedAt: left.deletedAt,
            parentThreadId: left.parentThreadId ?? null,
            attachedToParent: (left.attachedToParent ?? 0) > 0,
            move: left.move ?? null,
          },
          parentThreadId,
          home,
        );
      const parent = yield* read(parentThreadId);
      const canAdopt =
        parent !== undefined &&
        parent.deletedAt === null &&
        (parent.move ?? null) === null &&
        (parent.pendingMove ?? null) === null &&
        !((parent.parentThreadId ?? null) !== null && (parent.attachedToParent ?? 0) > 0) &&
        parent.projectId === projectId;
      if (!canAdopt) return own;
      const holds = (parent.childRequests?.remoteChildren ?? []).some(
        (entry) => entry.environmentId === home && entry.threadId === source.threadId,
      );
      if (holds) return { adopt: { parentThreadId } };
      // Back before this computer heard its move there landed: the parent's
      // child here whose own move to that computer still waits for the
      // answer, and this is the copy that move made there (its id is the
      // transfer's, from this computer's device there). Should the answer
      // land before the import, the decider finds the parent holding it.
      const leftMove = left?.move ?? null;
      if (!awaiting || fromThreadId === undefined || leftMove === null) return own;
      const there = Option.getOrUndefined(
        yield* outboundLinks
          .getByEnvironment(home)
          .pipe(
            Effect.mapError(
              () => new ImportStop({ reason: `${ownLabel()} couldn't read its links.` }),
            ),
          ),
      );
      return there !== undefined &&
        linkMoveCopyThreadId(there.deviceId, leftMove.transferId) === source.threadId
        ? {
            adopt: {
              parentThreadId,
              completesMoveOf: { threadId: fromThreadId, deviceId: there.deviceId },
            },
          }
        : own;
    });

  /**
   * The threads its agent started on this computer while it was on the one
   * it came from (docs/design/fleet.md, Part 3f, (g), "Also when the child's
   * computer is the target"), as their rows read. Read from this computer's
   * own records alone: threads started over this very link by the thread the
   * move came from, still here (not deleted or moved away; archived ones
   * too, so one the manifest names can say why it stays apart). Those the
   * manifest also names (`startedThere`) may become the arriving thread's
   * children; the rest stay apart, and it can't reach them. A failed read
   * names none rather than failing the move.
   */
  const threadsStartedHere = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const ids = yield* threadRows.listIdsByRemoteLink({ linkDeviceId: row.linkDeviceId });
      const found = yield* Effect.forEach(ids, (threadId) => threadRows.getById({ threadId }), {
        concurrency: 8,
      });
      return found.flatMap((entry): Array<ProjectionThread> => {
        const thread = Option.getOrUndefined(entry);
        return thread !== undefined &&
          thread.deletedAt === null &&
          thread.move?.movedAway === undefined &&
          thread.remoteOrigin?.linkDeviceId === row.linkDeviceId &&
          thread.remoteOrigin.threadId === row.manifest.source.threadId
          ? [thread]
          : [];
      });
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<ProjectionThread> => []));

  /**
   * Which of the threads it started here the arriving thread may take back
   * (the same check the decider makes again, adoptionRefusal), and the
   * "Moved here" words for the ones the manifest names that stay apart.
   * Only these are released: a thread that stays apart keeps what its link
   * asked of it.
   */
  const adoptionCandidates = (listed: ReadonlyArray<ProjectionThread>, arrival: AdoptionArrival) =>
    Effect.gen(function* () {
      const adoptable: Array<ProjectionThread> = [];
      const apart: Array<string> = [];
      for (const thread of listed) {
        const children = yield* threadRows.listAttachedChildIds({
          parentThreadId: thread.threadId,
        });
        const why = adoptionRefusal(
          {
            remoteOrigin: thread.remoteOrigin ?? null,
            projectId: thread.projectId,
            archivedAt: thread.archivedAt,
            moving: (thread.move ?? null) !== null || (thread.pendingMove ?? null) !== null,
            inFamily:
              ((thread.parentThreadId ?? null) !== null && (thread.attachedToParent ?? 0) > 0) ||
              children.length > 0,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          },
          arrival,
        );
        if (why === null) adoptable.push(thread);
        else apart.push(adoptionApartWords(thread.title, why));
      }
      return { adoptable, apart };
    }).pipe(
      Effect.mapError(() => new ImportStop({ reason: `${ownLabel()} couldn't read its threads.` })),
    );

  /**
   * After the thread landed: the threads it took back as its children here
   * are let go by the link again (LinkRequests.releaseThread), so a request
   * that arrived between their release and the import ends too, and its
   * message is taken back. Read from the projection, so a restart in between
   * finishes it. One that fails leaves the move unsettled (`importing`), so
   * the sweep tries the whole of it again before it settles.
   */
  const releaseAdopted = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const adopted = yield* threadRows.listAdoptedChildIds({ parentThreadId: row.threadId });
      for (const threadId of adopted) yield* requests.releaseThread(row.linkDeviceId, threadId);
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("a moved thread's adopted threads couldn't be released by their link", {
          threadId: row.threadId,
          detail: String(error),
        }),
      ),
    );

  /** The "Moved here" words for threadsStartedHere, or null for none. */
  const startedHereWords = (titles: ReadonlyArray<string>) => {
    if (titles.length === 0) return null;
    const [only] = titles;
    return titles.length === 1 && only !== undefined
      ? `Its thread '${only}' is already on this computer. It stays separate, so this thread can't reach it.`
      : `${titles.length} threads it started are already on this computer: ${titles.slice(0, PEER_MOVE_FAMILY_MAX_STAYED).join(", ")}. They stay separate, so this thread can't reach them.`;
  };

  /**
   * The thread itself, and with it the commit. Waits for the engine's answer
   * without letting go. A family member in another's folder (docs/design/
   * fleet.md, Part 3f, (g)) takes the folder that member's move made here,
   * when that move is still coming. It holds only its own lock: no import
   * ever waits for a second one, so none can wait on each other. The folder
   * stays because the owner's clean-up leaves it while a member still coming
   * shares it (cleanUp), and once this thread is in it.
   */
  const commitStage = (row: LinkMoveRow) => {
    const ownerId = row.manifest.family?.sharesCheckoutOf;
    const key = row.familyKey;
    if (ownerId === undefined || key === null) return commitThread(row);
    return Effect.gen(function* () {
      const owner = yield* moves
        .findFamilyMember(key, ownerId)
        .pipe(Effect.mapError(() => peerFailure(`${ownLabel()} couldn't read its moves.`)));
      if (
        Option.isNone(owner) ||
        owner.value.status === "aborted" ||
        owner.value.manifest.family?.sharesCheckoutOf !== undefined ||
        !folderMade(owner.value) ||
        owner.value.worktreePath === null ||
        owner.value.branch === null
      ) {
        return yield* stop(OWNER_DIDNT_MOVE);
      }
      if (!sameProjectAs(owner.value.manifest, row.manifest)) {
        return yield* stop(OTHER_PROJECTS_FOLDER);
      }
      return yield* commitThread({
        ...row,
        worktreePath: owner.value.worktreePath,
        branch: owner.value.branch,
      });
    });
  };

  /** commitStage's work, for a row whose folder is known (its own, or the one it shares). */
  const commitThread = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const land = yield* landing(row.manifest);
      if (land === null) return yield* stop(`${ownLabel()} doesn't have this project anymore.`);
      const authority = yield* requests.authority(row.linkDeviceId);
      if (!authority.ok) return yield* stop(authority.text);
      const agent = yield* requests.resolveAgentFor({
        agent: {
          instanceId: row.manifest.agent.instanceId,
          model: row.manifest.agent.model,
          ...(row.manifest.agent.options !== undefined
            ? { options: row.manifest.agent.options }
            : {}),
        },
        interactionMode: row.manifest.thread.interactionMode,
      });
      if ("refused" in agent) return yield* stop(agent.refused);
      const capped = clampLaunchToCeiling(
        {
          runtimeMode: row.manifest.thread.runtimeMode,
          interactionMode: row.manifest.thread.interactionMode,
        },
        {
          runtimeMode: authority.maxRuntimeMode,
          interactionMode: row.manifest.thread.interactionMode,
        },
      );
      const attachments = yield* importAttachments(row);
      const key = row.transferKey;
      // A family member's turns and messages are named from its family's key
      // and its own thread there (linkMoveMessageId), so its relatives'
      // records here name its turns alike and no two members share an id.
      const family = familyOf(row);
      const messages = row.manifest.thread.messages.map((message): ThreadImportMessage => ({
        messageId: linkMoveMessageId(row, message.messageId),
        role: message.role,
        text: message.text,
        ...(message.attachments !== undefined
          ? {
              attachments: message.attachments.map(
                (attachment) => attachments.get(attachment.id) ?? attachment,
              ),
            }
          : {}),
        turnId:
          message.turnId === null
            ? null
            : linkMoveTurnId(row, row.manifest.source.threadId, message.turnId),
        ...(message.completesTurn !== undefined ? { completesTurn: message.completesTurn } : {}),
        ...(message.agentModels !== undefined ? { agentModels: message.agentModels } : {}),
        ...(message.sentFrom !== undefined ? { sentFrom: message.sentFrom } : {}),
        // Never reached the agent there: no history here may carry it either.
        ...(message.notSent === true ? { notSent: true as const } : {}),
        // A room's (remapped below): who it was to or from, and its request.
        ...(message.participantId !== undefined ? { participantId: message.participantId } : {}),
        ...(message.fromAgent !== undefined ? { fromAgent: message.fromAgent } : {}),
        ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
        ...(message.requestKind !== undefined ? { requestKind: message.requestKind } : {}),
        ...(message.requestOutcome !== undefined ? { requestOutcome: message.requestOutcome } : {}),
        ...(message.requestError !== undefined ? { requestError: message.requestError } : {}),
        // Between members of its family only, named as they are here.
        ...(message.fromThread !== undefined && family !== null
          ? { fromThread: family.fromThread(message.fromThread) }
          : {}),
        createdAt: message.createdAt,
      }));
      const device = yield* devices
        .getDevice(row.linkDeviceId)
        .pipe(Effect.orElseSucceed(Option.none));
      // A thread that already landed carried its sessions then (or didn't):
      // its agents may have used them since, so they are never written again.
      const landedBefore = yield* importLanded(row);
      const carried =
        row.manifest.session !== undefined && !landedBefore
          ? yield* carrySession(
              row,
              { session: row.manifest.session, bindingKey: row.threadId },
              agent.selection.instanceId,
              capped.runtimeMode,
            )
          : false;
      // A room's agents (docs/design/fleet.md, Part 3f, (i)): each as the
      // agent picked here, with its own session when one came for it; one
      // with none here arrives as having left.
      const roomResolved = yield* resolveRoomAgents(row.manifest);
      const carriedRoom = new Set<string>();
      for (const participant of row.manifest.thread.room?.participants ?? []) {
        const resolved = roomResolved.get(participant.id);
        if (participant.session === undefined || landedBefore || resolved === undefined) continue;
        if (!("selection" in resolved)) continue;
        const bindingKey = participantSessionKey(
          row.threadId,
          movedParticipantId(key, participant.id),
        );
        if (
          yield* carrySession(
            row,
            { session: participant.session, participantId: participant.id, bindingKey },
            resolved.selection.instanceId,
            capped.runtimeMode,
          )
        ) {
          carriedRoom.add(participant.id);
        }
      }
      const now = yield* nowIso;
      const drivers = yield* readyDrivers;
      const room = roomArrivalOf({
        room: row.manifest.thread.room,
        transferKey: key,
        now,
        resolved: roomResolved,
        carried: carriedRoom,
        hasDriver: (driver) => drivers.has(driver),
        messageIdHere: (id) => linkMoveMessageId(row, id),
      });
      // How far the thread's own agent's carried session got, in a room.
      const ownSeen = row.manifest.thread.room?.ownAgentSeenThroughMessageId;
      const roomMessages = messages.map((message) => remapRoomMessage(message, room.ids));
      const activities = row.manifest.thread.activities.map((activity) =>
        remapRoomActivity(
          {
            ...activity,
            id: EventId.make(derivedUuid("link-move-activity", key, activity.id)),
            turnId: null,
          },
          room.ids,
        ),
      );
      const outsideWork = remapOutsideWork(row.manifest.thread.outsideWork, room.ids, room.came);
      const fromLabel = Option.isSome(device)
        ? device.value.label
        : row.manifest.source.environmentLabel;
      const scratch = isScratchMoveManifest(row.manifest);
      const {
        pullRequestSwitches,
        arrival: stateArrival,
        notSent,
        ...state
      } = yield* importedState({
        row,
        root: land.root,
        instanceId: agent.selection.instanceId,
        runtimeMode: capped.runtimeMode,
        interactionMode: capped.interactionMode,
        attachments,
        fromLabel,
        now,
        room,
      });
      // A child lands under its parent here, when the parent landed and is
      // still here (Part 3f, (g)); otherwise as its own thread, with why.
      const lineage = family === null ? null : yield* family.lineage(land.project.id);
      const startedHere = yield* threadsStartedHere(row);
      // Archived ones aren't named as here, unless the manifest names them (below).
      const liveHere = startedHere.filter((thread) => thread.archivedAt === null);
      const familyLeft =
        family === null
          ? []
          : family.left(
              fromLabel,
              lineage?.left ?? null,
              new Set(liveHere.map((entry) => entry.title)),
            );
      // Across the link its work came over (Part 3f, (h)): from this link alone.
      const across = yield* linkLanding(
        row,
        land.project.id,
        authority.pinnedEnvironmentId,
        fromLabel,
      );
      if (across.left !== undefined) familyLeft.push(across.left);
      // The threads it started here that may be its children again (Part 3f,
      // (g)): named by both the manifest and this computer's own records,
      // only for a thread that lands on its own here, and only those that
      // pass the check the decider makes again (its modes as the import
      // writes them). One the manifest names that doesn't pass says why;
      // the others stay apart, named here.
      const askedBack = new Map(
        (row.manifest.startedThere ?? []).map((entry) => [entry.threadId as string, entry]),
      );
      const topLevel =
        lineage?.lineage === undefined &&
        across.remoteOrigin === undefined &&
        across.adopt === undefined;
      const listed = topLevel ? startedHere.filter((entry) => askedBack.has(entry.threadId)) : [];
      const listedIds = new Set<string>(listed.map((entry) => entry.threadId));
      const { adoptable, apart } = yield* adoptionCandidates(listed, {
        linkDeviceId: row.linkDeviceId,
        sourceThreadId: row.manifest.source.threadId,
        fromEnvironmentId: authority.pinnedEnvironmentId ?? row.manifest.source.environmentId,
        fromPinned: authority.pinnedEnvironmentId !== null,
        projectId: land.project.id,
        runtimeMode: capped.runtimeMode,
        interactionMode: capped.interactionMode,
      });
      const startedHereLine = startedHereWords(
        liveHere.filter((entry) => !listedIds.has(entry.threadId)).map((entry) => entry.title),
      );
      if (startedHereLine !== null) familyLeft.push(startedHereLine);
      familyLeft.push(...apart);
      // The "Moved here" line's room words first, then its family's, then
      // what the thread had going.
      const arrival =
        stateArrival === undefined &&
        room.brought.length === 0 &&
        room.left.length === 0 &&
        familyLeft.length === 0
          ? undefined
          : {
              ...(stateArrival?.message !== undefined ? { message: stateArrival.message } : {}),
              brought: [...room.brought, ...(stateArrival?.brought ?? [])],
              left: [...room.left, ...familyLeft, ...(stateArrival?.left ?? [])],
            };
      // Every message id it brings is its own: one another thread here holds
      // would be moved into this one (messages are kept by id alone). The
      // decider checks the recent ones too; this reads them all.
      if (yield* messageIdsTaken(row.threadId, [...roomMessages, ...notSent])) {
        return yield* stop(`${ownLabel()} already has one of its messages in another thread.`);
      }
      // While the link still holds them: what it asked of them ends here,
      // so nothing it asked can act on them once they are this thread's.
      // Again on a retry (it is safe to); should the import then fail, they
      // stay the link's, with those requests ended.
      for (const entry of adoptable) {
        yield* requests.releaseThread(row.linkDeviceId, entry.threadId);
      }
      const dispatched = yield* engine
        .dispatch({
          type: "thread.import",
          commandId: importCommandId(row),
          threadId: row.threadId,
          projectId: land.project.id,
          title: row.manifest.thread.title,
          modelSelection: agent.selection,
          runtimeMode: capped.runtimeMode,
          interactionMode: capped.interactionMode,
          // A general chat works in its folder as every general chat does: by its id.
          branch: scratch ? null : row.branch,
          worktreePath: scratch ? null : row.worktreePath,
          movedFrom: {
            // The computer this link was made for, when its invite pinned
            // it; else only what the move says (Part 3f, (h)).
            ...(authority.pinnedEnvironmentId !== null
              ? {
                  environmentId: EnvironmentId.make(authority.pinnedEnvironmentId),
                  environmentPinned: true as const,
                }
              : { environmentId: row.manifest.source.environmentId }),
            label: fromLabel,
            threadId: row.manifest.source.threadId,
            movedAt: now,
            ...(carried && ownSeen !== undefined
              ? { seenThrough: linkMoveMessageId(row, ownSeen) }
              : {}),
            ...(pullRequestSwitches !== undefined ? { pullRequestSwitches } : {}),
            ...(row.familyKey !== null ? { familyKey: row.familyKey } : {}),
          },
          // Queued messages for a room agent that didn't come: in the chat, never sent.
          messages: [...roomMessages, ...notSent],
          activities,
          ...(lineage?.lineage !== undefined ? { lineage: lineage.lineage } : {}),
          ...(across.remoteOrigin !== undefined ? { remoteOrigin: across.remoteOrigin } : {}),
          ...(across.adopt !== undefined ? { adopt: across.adopt } : {}),
          // The link is this transfer's own, never one the manifest names.
          ...(adoptable.length > 0
            ? {
                adoptsChildren: {
                  linkDeviceId: row.linkDeviceId,
                  children: adoptable.map((entry) => {
                    const override = askedBack.get(entry.threadId)?.override;
                    return {
                      threadId: entry.threadId,
                      ...(override !== undefined ? { override } : {}),
                    };
                  }),
                },
              }
            : {}),
          ...(family?.worktreeOrigin !== undefined
            ? { worktreeOrigin: family.worktreeOrigin }
            : {}),
          ...(carried ? { nativeSession: "carried" as const } : {}),
          ...(room.participants.length > 0 ? { participants: room.participants } : {}),
          ...(room.agentRole !== undefined ? { agentRole: room.agentRole } : {}),
          ...(outsideWork.length > 0 ? { outsideWork } : {}),
          ...state,
          ...(arrival !== undefined ? { arrival } : {}),
          createdAt: now,
        })
        .pipe(Effect.uninterruptible, Effect.exit);
      if (Exit.isFailure(dispatched) && !(yield* importLanded(row))) {
        return yield* stop(`${ownLabel()} couldn't create the thread.`);
      }
      // Landed: a carried session's files are the thread's now.
      const carriedFiles = yield* readCarriedRecord(row);
      if (carriedFiles !== null) yield* releaseSessionFiles(carriedFiles, row.transferKey);
      yield* settleLanded(row).pipe(Effect.ignore);
      yield* arrive(row);
    });

  /** The ids a move's import gives the queue it writes: its arrival message, then the user's. */
  const arrivalMessageId = (row: Pick<LinkMoveRow, "transferKey">) =>
    MessageId.make(derivedUuid("link-move-arrival", row.transferKey));
  /** A room agent's arrival message (Part 3f, (i)), by its id there. */
  const roomArrivalMessageId = (row: Pick<LinkMoveRow, "transferKey">, participantId: string) =>
    MessageId.make(derivedUuid("link-move-arrival", row.transferKey, participantId));
  const queuedMessageId = (row: Pick<LinkMoveRow, "transferKey">, id: string) =>
    MessageId.make(derivedUuid("link-move-queued", row.transferKey, id));

  /**
   * What a moved thread had going, as it lands here (docs/design/fleet.md,
   * Part 3e), for the agent picked here: its goal as it arrives, its pull
   * request switches (off, with why, when its branch had to be renamed), its
   * plans and queue with this computer's ids, and the arrival: the message
   * its agent is told, and the "Moved here" line's two lists.
   */
  const importedState = (input: {
    readonly row: LinkMoveRow;
    readonly root: string;
    readonly instanceId: ProviderInstanceId;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly attachments: ReadonlyMap<string, ChatAttachment>;
    readonly fromLabel: string;
    readonly now: string;
    /** A room's agents as they land (roomImport.ts). */
    readonly room: RoomArrival;
  }) =>
    Effect.gen(function* () {
      const { row, now, room } = input;
      const state = row.manifest.thread.state;
      if (state === undefined) {
        return {
          pullRequestSwitches: undefined,
          arrival: undefined,
          notSent: [] as ReadonlyArray<ThreadImportMessage>,
        };
      }
      const key = row.transferKey;
      const capabilitiesOf = (instanceId: ProviderInstanceId) =>
        providers.getCapabilities(instanceId).pipe(Effect.orElseSucceed(() => null));
      const capabilities = yield* capabilitiesOf(input.instanceId);
      const setsCheckBacks = capabilities?.checkBacks === "supported";
      const brought: string[] = [];
      const left: string[] = [];
      /** A room agent's name, by its id there. */
      const handleOf = (id: string) =>
        row.manifest.thread.room?.participants.find((entry) => entry.id === id)?.handle ??
        "An agent";

      // (a) The goal: its agent's, the one that held it there (a room's
      // session slot), or the thread's own.
      let goal: OrchestrationThreadGoal | undefined;
      let goalToTell: { readonly objective: string } | null = null;
      const carriedGoal = state.goal;
      const goalHolder = carriedGoal?.participantId;
      const holderHere = goalHolder === undefined ? undefined : room.came.get(goalHolder);
      const goalCapabilities =
        holderHere === undefined
          ? capabilities
          : yield* capabilitiesOf(holderHere.instanceId as ProviderInstanceId);
      const keepsGoals = goalCapabilities?.threadGoals === "supported";
      const keepsBudgets = keepsGoals && goalCapabilities?.threadGoalBudget !== "unsupported";
      if (carriedGoal !== undefined) {
        // Only a goal still working or paused is picked up; one that finished stays finished.
        const pickUp =
          carriedGoal.pickUp &&
          (carriedGoal.status === "active" || carriedGoal.status === "paused");
        const { pickUp: _pickUp, participantId: _holder, ...record } = carriedGoal;
        if (goalHolder !== undefined && holderHere === undefined) {
          // The agent that held it didn't come: it waits for the user to resume it here.
          goal = {
            ...record,
            threadId: row.threadId,
            status: carriedGoal.status === "complete" ? "complete" : "paused",
          };
          if (carriedGoal.status !== "complete") {
            left.push(`Its goal came paused: ${handleOf(goalHolder)}, who held it, didn't come.`);
          }
        } else if (!keepsGoals) {
          left.push(
            `Its goal didn't come along: the agent here can't keep goals. It was: ${carriedGoal.objective}`,
          );
          if (pickUp) goalToTell = { objective: carriedGoal.objective };
        } else if (
          carriedGoal.tokenBudget !== null &&
          !keepsBudgets &&
          carriedGoal.status !== "complete"
        ) {
          // The agent here refuses a budget: the goal waits, and Resume runs it without one.
          goal = { ...record, threadId: row.threadId, status: "paused", tokenBudget: null };
          left.push(
            "Its goal came paused: the agent here can't keep its token budget. Resume runs it without one.",
          );
        } else {
          const status = pickUp
            ? "active"
            : carriedGoal.status === "active" ||
                carriedGoal.status === "paused" ||
                carriedGoal.status === "usageLimited"
              ? "paused"
              : carriedGoal.status;
          goal = { ...record, threadId: row.threadId, status };
          if (pickUp) goalToTell = { objective: carriedGoal.objective };
          if (carriedGoal.status !== "complete") {
            brought.push(status === "paused" ? "its goal, paused" : "its goal");
          }
        }
      }

      // (b) Check-backs: their agent sets them again (or is told once). A
      // room agent's go to it; one that didn't come leaves its own behind.
      const allCheckBacks = state.checkBacks ?? [];
      const checkBacks = allCheckBacks.filter((entry) => entry.participantId === undefined);
      const roomCheckBacks = new Map<string, typeof allCheckBacks>();
      const stayedBehind = new Set<string>();
      for (const entry of allCheckBacks) {
        if (entry.participantId === undefined) continue;
        if (!room.came.has(entry.participantId)) {
          stayedBehind.add(entry.participantId);
          continue;
        }
        roomCheckBacks.set(entry.participantId, [
          ...(roomCheckBacks.get(entry.participantId) ?? []),
          entry,
        ]);
      }
      for (const id of stayedBehind) {
        left.push(`Check-backs ${handleOf(id)} set stayed behind: it didn't come.`);
      }
      if (checkBacks.length > 0) {
        if (setsCheckBacks) {
          brought.push(
            checkBacks.length === 1
              ? "a check-back to set again"
              : `${checkBacks.length} check-backs to set again`,
          );
        } else {
          left.push(
            "Its check-backs didn't come along: the agent here can't set them. It's told once what was planned.",
          );
        }
      }

      // (c) Pull requests: the links come along, every switch off. A switch
      // acts with this computer's GitHub sign-in, so only the user here turns
      // one on; the "Moved here" line and the thread's notice offer what was
      // on there (movedFrom.pullRequestSwitches).
      let pullRequestSwitches: ThreadMovedFrom["pullRequestSwitches"];
      let pullRequests:
        | {
            readonly autoFix: boolean;
            readonly autoMerge: PullRequestMergeMethod | null;
            readonly linked: ReadonlyArray<OrchestrationThreadLinkedPullRequest>;
          }
        | undefined;
      const carriedSwitches = state.pullRequests;
      if (carriedSwitches !== undefined) {
        const moved = gitOf(row.manifest);
        const numbers = carriedSwitches.linked.map((entry) => `#${entry.number}`);
        const which =
          numbers.length > 0 ? `pull request ${numbers.join(", ")}` : "its pull request";
        // A branch renamed here doesn't push to the pull request; one that
        // tracks nothing can't tell what isn't pushed yet.
        const renamed = moved?.branch !== null && row.branch !== moved?.branch;
        const untracked =
          !renamed &&
          moved?.upstreamBranch !== undefined &&
          row.branch !== null &&
          (yield* upstreamOf(input.root, row.branch)) === null;
        const off = renamed
          ? `Auto-fix is off here: this computer already has a branch named \`${moved?.branch ?? ""}\`, so pushes from this thread wouldn't reach ${which}.`
          : untracked
            ? `Auto-fix is off here: this thread's branch couldn't track ${moved?.upstreamBranch ?? "its branch"} on this computer, so it can't tell what isn't pushed yet.`
            : null;
        pullRequests = {
          autoFix: false,
          autoMerge: null,
          linked: carriedSwitches.linked.map((entry) => ({
            number: entry.number,
            url: entry.url,
            autoFix: false,
            autoMerge: null,
          })),
        };
        if (numbers.length > 0) brought.push(which);
        const wasOn = movedPullRequestSwitchesWords(carriedSwitches, input.fromLabel);
        if (off !== null) {
          if (pullRequestSwitchesWords(carriedSwitches) !== null) left.push(off);
        } else if (wasOn !== null) {
          pullRequestSwitches = {
            autoFix: carriedSwitches.autoFix,
            autoMerge: carriedSwitches.autoMerge,
            linked: carriedSwitches.linked
              .filter((entry) => entry.autoFix || entry.autoMerge !== null)
              .map((entry) => ({
                number: entry.number,
                url: entry.url,
                autoFix: entry.autoFix,
                autoMerge: entry.autoMerge,
              })),
          };
          left.push(wasOn);
          const ready = yield* gitHubReadiness(input.root);
          if (ready.gitHubReady === false) {
            left.push("GitHub isn't signed in on this computer. Sign in before you turn them on.");
          }
        }
      }

      // (e) The user's queued messages, on the agent picked here, with this computer's ids.
      const skipped = (state.queuedFollowUps ?? []).filter(
        (entry) => (entry.skills ?? []).length > 0,
      ).length;
      // One for a room agent that didn't come is written into the chat, never
      // sent (Part 3f, (i)); the others go to their agent here.
      const forAgent = (entry: { readonly participantId?: string | undefined }) =>
        entry.participantId === undefined ? null : (room.ids.get(entry.participantId) ?? null);
      const cameFor = (entry: { readonly participantId?: string | undefined }) =>
        entry.participantId === undefined ||
        room.came.has(entry.participantId) ||
        !room.ids.has(entry.participantId);
      const queuedFollowUps: OrchestrationQueuedFollowUp[] = (state.queuedFollowUps ?? [])
        .filter(cameFor)
        .map((entry) => {
          const participantId = forAgent(entry);
          return {
            messageId: queuedMessageId(row, entry.messageId),
            text: entry.text,
            attachments: entry.attachments.map(
              (attachment) => input.attachments.get(attachment.id) ?? attachment,
            ),
            ...(entry.composer !== undefined ? { composer: entry.composer } : {}),
            // Not `sentFrom`: only this server stamps it (decideThreadImport drops one too).
            ...(participantId !== null ? { participantId } : {}),
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            createdAt: entry.createdAt,
          };
        });
      const unsentFor = new Set<string>();
      const notSent: ThreadImportMessage[] = (state.queuedFollowUps ?? [])
        .filter((entry) => !cameFor(entry))
        .map((entry) => {
          const participantId = forAgent(entry);
          if (entry.participantId !== undefined) unsentFor.add(entry.participantId);
          return {
            messageId: queuedMessageId(row, entry.messageId),
            role: "user" as const,
            text: entry.text,
            ...(entry.attachments.length > 0
              ? {
                  attachments: entry.attachments.map(
                    (attachment) => input.attachments.get(attachment.id) ?? attachment,
                  ),
                }
              : {}),
            turnId: null,
            // Not `sentFrom`: only this server stamps it (decideThreadImport drops one too).
            ...(participantId !== null ? { participantId } : {}),
            notSent: true as const,
            createdAt: entry.createdAt,
          };
        });
      for (const id of unsentFor) {
        left.push(`Your queued message for ${handleOf(id)} wasn't sent: it didn't come.`);
      }
      if (queuedFollowUps.length > 0) {
        brought.push(
          queuedFollowUps.length === 1
            ? "1 queued message"
            : `${queuedFollowUps.length} queued messages`,
        );
      }
      if (skipped > 0) {
        left.push("Skills named in its queued messages stayed behind: send them again here.");
      }

      // (f) Plans, with this computer's ids.
      const key2 = (id: string) => linkMoveTurnId(row, row.manifest.source.threadId, id);
      const proposedPlans: OrchestrationProposedPlan[] = (state.proposedPlans ?? []).map(
        (plan) => ({
          id: derivedUuid("link-move-plan", key, plan.id),
          turnId: plan.turnId === null ? null : TurnId.make(key2(plan.turnId)),
          planMarkdown: plan.planMarkdown,
          implementedAt: plan.implementedAt,
          implementationThreadId:
            plan.implementationThreadId === row.manifest.source.threadId ? row.threadId : null,
          dismissedAt: plan.dismissedAt,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        }),
      );
      const newest = proposedPlans.at(-1);
      if (newest !== undefined && newest.implementedAt === null && newest.dismissedAt === null) {
        brought.push("its plan");
      }
      const behind = state.plansLeftBehind ?? 0;
      if (behind > 0) {
        left.push(
          behind === 1
            ? `1 older plan stayed on ${input.fromLabel}.`
            : `${behind} older plans stayed on ${input.fromLabel}.`,
        );
      }

      // The arrival: one message per agent that has something to be told,
      // addressed to it (the goal to its holder, check-backs to whoever set
      // them); the thread's own agent's first, then the room's, then the
      // user's queued messages.
      const text = arrivalMessageText({
        kind: "moved",
        from: input.fromLabel,
        to: ownLabel(),
        goal: goalHolder === undefined ? goalToTell : null,
        checkBacks,
        canSetCheckBacks: setsCheckBacks,
        now,
      });
      const roomArrivals: OrchestrationQueuedFollowUp[] = [];
      for (const [oldId, selection] of room.came) {
        const own = roomCheckBacks.get(oldId) ?? [];
        const told = goalHolder === oldId ? goalToTell : null;
        if (own.length === 0 && told === null) continue;
        const agentCapabilities = yield* capabilitiesOf(selection.instanceId as ProviderInstanceId);
        const agentText = arrivalMessageText({
          kind: "moved",
          from: input.fromLabel,
          to: ownLabel(),
          goal: told,
          checkBacks: own,
          canSetCheckBacks: agentCapabilities?.checkBacks === "supported",
          now,
        });
        const participantId = room.ids.get(oldId);
        if (agentText === null || participantId === undefined) continue;
        roomArrivals.push({
          messageId: roomArrivalMessageId(row, oldId),
          text: agentText,
          attachments: [],
          participantId,
          afterMove: true,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdAt: now,
        });
      }
      const queue = [...roomArrivals, ...queuedFollowUps];
      return {
        ...(goal !== undefined ? { goal } : {}),
        ...(pullRequests !== undefined ? { pullRequests } : {}),
        ...(queue.length > 0 ? { queuedFollowUps: queue } : {}),
        ...(proposedPlans.length > 0 ? { proposedPlans } : {}),
        ...(pullRequestSwitches !== undefined ? { pullRequestSwitches } : {}),
        notSent,
        arrival: {
          ...(text !== null ? { message: { messageId: arrivalMessageId(row), text } } : {}),
          brought,
          left,
        },
      };
    });

  /**
   * Whether GitHub is signed in here for the project at `root`: `gh auth
   * status` answers. Absent: it couldn't tell (no `gh`, a read that failed).
   */
  const gitHubReadiness = (root: string) =>
    Effect.gen(function* () {
      if (Option.isNone(gitHubCli)) return {} satisfies PeerMoveReadinessResult;
      const result = yield* gitHubCli.value
        .execute({ cwd: root, args: ["auth", "status"], timeoutMs: 15_000 })
        .pipe(Effect.option);
      return Option.isSome(result)
        ? ({ gitHubReady: true } satisfies PeerMoveReadinessResult)
        : ({ gitHubReady: false } satisfies PeerMoveReadinessResult);
    });

  const readiness: LinkMovesShape["readiness"] = (link, input) =>
    Effect.gen(function* () {
      const authority = yield* requests.authority(link.deviceId);
      if (!authority.ok) return yield* new PeerRpcError({ detail: authority.text });
      const project = yield* requests.projectForKey(input.canonicalKey);
      if (project === undefined) return {};
      return yield* gitHubReadiness(project.workspaceRoot);
    });

  /**
   * The arrival (docs/design/fleet.md, Part 3e, "One kick"): the head of the
   * queue its import wrote is sent, with a command id from the move, then the
   * move is recorded as arrived. The import's queue events send nothing, so
   * this is the one send; a restart before it is recorded sends it then. A
   * thread already at work here (its user sent something first) is left to
   * its turn's end, which sends the queue as it always does.
   */
  const arrive = (row: LinkMoveRow) =>
    Effect.gen(function* () {
      const state = row.manifest.thread.state;
      const ids = new Set<string>([
        arrivalMessageId(row),
        ...(row.manifest.thread.room?.participants ?? []).map((entry) =>
          roomArrivalMessageId(row, entry.id),
        ),
        ...(state?.queuedFollowUps ?? []).map((entry) => queuedMessageId(row, entry.messageId)),
      ]);
      // Unreadable: left for the sweep to try again, never taken as gone.
      const shell = yield* snapshots.getThreadShellById(row.threadId).pipe(Effect.option);
      if (Option.isNone(shell)) return;
      const thread = Option.getOrNull(shell.value);
      const head =
        state === undefined || thread === null
          ? undefined
          : (thread.queuedFollowUps ?? []).find((entry) => ids.has(entry.messageId));
      const busy = thread?.session?.status === "running" || thread?.session?.status === "starting";
      if (head !== undefined && !busy) {
        const commandId = CommandId.make(`server:link-move:${row.transferKey}:arrive`);
        const sent = yield* engine
          .dispatch({
            type: "thread.follow-up.send-queued",
            commandId,
            threadId: row.threadId,
            messageId: head.messageId,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.exit);
        if (Exit.isFailure(sent)) {
          // A refusal the engine recorded is an answer (the message went some
          // other way); anything else is tried again by the sweep.
          const receipt = yield* engine
            .getCommandReceipt(commandId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          yield* Effect.logWarning("moved thread's arrival wasn't sent", {
            threadId: row.threadId,
            cause: sent.cause,
          });
          if (Option.isNone(receipt)) return;
        }
      }
      yield* moves
        .markArrived({
          linkDeviceId: row.linkDeviceId,
          transferId: row.transferId,
          now: yield* nowIso,
        })
        .pipe(Effect.ignore);
    });

  /**
   * Runs an import from where it stopped. Each stage holds the transfer's
   * lock and checks the link again; a stage that can't go on ends the move
   * aborted, with the reason the other computer shows.
   */
  const runImport = (linkDeviceId: string, transferId: string): Effect.Effect<void> => {
    const key = linkMoveKey(linkDeviceId, transferId);
    // One that is ending (a family member that just let its slot go) runs
    // once more after it ends, so a start asked meanwhile is never lost.
    if (importing.has(key)) {
      importAgain.add(key);
      return Effect.void;
    }
    importing.add(key);
    const steps = Effect.gen(function* () {
      for (;;) {
        const next = yield* stage(linkDeviceId, transferId, (row) =>
          Effect.gen(function* () {
            // A family member waiting for a relative (Part 3f, (g)) lets its
            // slot go; startImports picks it up again once it may go on.
            const gate = yield* familyGate(row);
            if (gate.kind === "stop") return yield* stop(gate.reason);
            if (gate.kind === "wait") {
              yield* setStage(row, { status: "waiting_for_family" });
              return true;
            }
            switch (row.stage) {
              case null:
                // A general chat has a folder of its own, not a checkout; a
                // family member in another's folder takes that one.
                yield* isScratchMoveManifest(row.manifest)
                  ? folderStage(row)
                  : row.manifest.family?.sharesCheckoutOf !== undefined
                    ? sharerStage(row)
                    : fetchStage(row);
                return false;
              case "fetched":
                yield* worktreeStage(row);
                return false;
              case "worktree":
                yield* applyStage(row);
                return false;
              case "folder":
                yield* scratchApplyStage(row);
                return false;
              case "applied":
                yield* commitStage(row);
                return true;
              case "arrived":
                return true;
            }
          }),
        );
        if (next === null || next.value) return;
      }
    });
    return steps.pipe(
      // A stage that can't go on ends the move. Anything else (a read that
      // failed) leaves it importing for the sweep to pick up again.
      Effect.catchTag("ImportStop", (failure) =>
        Effect.gen(function* () {
          const found = yield* readRow(linkDeviceId, transferId);
          if (Option.isSome(found)) {
            yield* lock(key)(abortRow(found.value, failure.reason));
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("link move import failed", { transferId, cause }),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          importing.delete(key);
          return importAgain.delete(key)
            ? runImport(linkDeviceId, transferId).pipe(Effect.forkIn(scope), Effect.asVoid)
            : Effect.void;
        }),
      ),
      // Its slot is free: an allowed move waiting for one goes next.
      Effect.ensuring(Effect.suspend(() => startImports)),
    );
  };

  /**
   * Starts the imports of allowed moves waiting for a slot (`waitingToImport`),
   * oldest first, as far as the caps in flight allow; the rest wait for the
   * next import to end, or the sweep. Counted and recorded under the
   * admission lock, as offers are, so the two never overrun the caps together.
   */
  const startImports: Effect.Effect<void> = Effect.gen(function* () {
    const dropped: Array<{ readonly row: LinkMoveRow; readonly reason: string }> = [];
    const started = yield* lock("admission")(
      Effect.gen(function* () {
        const open = yield* moves.listOpen;
        const inFlight = open.filter((entry) => !holdsNoSlot(entry));
        const begun: Array<LinkMoveRow> = [];
        // Family members whose relative is here now go on first (they are
        // furthest along); one whose relative was dropped ends.
        const ready: Array<LinkMoveRow> = [];
        for (const row of open.filter((entry) => entry.status === "waiting_for_family")) {
          const gate = yield* familyGate(row).pipe(
            Effect.orElseSucceed(() => ({ kind: "wait" }) as const),
          );
          if (gate.kind === "stop") dropped.push({ row, reason: gate.reason });
          else if (gate.kind === "ready") ready.push(row);
        }
        for (const row of [...ready, ...open.filter(waitingToImport)]) {
          const fromLink = inFlight.filter((entry) => entry.linkDeviceId === row.linkDeviceId);
          if (fromLink.length >= MAX_OPEN_MOVES_PER_LINK || inFlight.length >= MAX_OPEN_MOVES) {
            continue;
          }
          // Not if it ended meanwhile: a settled row isn't changed.
          const moved = yield* moves.update({
            linkDeviceId: row.linkDeviceId,
            transferId: row.transferId,
            patch: { status: "importing" },
            now: yield* nowIso,
          });
          if (!moved) continue;
          const next = { ...row, status: "importing" as const };
          inFlight.push(next);
          begun.push(next);
        }
        return begun;
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("link moves waiting to import couldn't be started", {
          cause: error,
        }).pipe(Effect.as([] as Array<LinkMoveRow>)),
      ),
    );
    for (const row of started) {
      yield* runImport(row.linkDeviceId, row.transferId).pipe(Effect.forkIn(scope));
    }
    for (const { row, reason } of dropped) {
      yield* abortMove(row.linkDeviceId, row.transferId, reason).pipe(
        Effect.catch((error) =>
          Effect.logWarning("link move waiting for its family couldn't be dropped", {
            detail: error.message,
          }),
        ),
        Effect.forkIn(scope),
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Asking this computer's user
  // ---------------------------------------------------------------------------

  const respond: LinkMovesShape["respond"] = (input) =>
    Effect.gen(function* () {
      const unrecorded = () =>
        new ComputerLinkError({ detail: "That answer couldn't be recorded. Try again." });
      // Read and answered under the move's lock, so a cancel that lands at
      // the same moment either comes first (and this answer is refused) or
      // after (and drops the allowed move).
      const answered = yield* lock(linkMoveKey(input.deviceId, input.requestId))(
        Effect.gen(function* () {
          const found = yield* readRow(input.deviceId, input.requestId);
          if (Option.isNone(found)) return null;
          const row = found.value;
          if (row.status !== "awaiting_approval") {
            return yield* new ComputerLinkError({ detail: "That move is no longer waiting." });
          }
          if (!input.allow) {
            yield* abortRow(row, `${ownLabel()} didn't allow the move.`, "denied");
            return "answered" as const;
          }
          // Every byte is here already (it was sent before Allow): it is set
          // up as soon as a slot is free, whether or not the computer it left
          // is still on.
          if (staged(row)) {
            if (!(yield* verifyPayload(row))) {
              yield* abortRow(
                row,
                `What arrived on ${ownLabel()} doesn't match what was sent. Try again.`,
              );
              return "answered" as const;
            }
            yield* moves.update({
              linkDeviceId: row.linkDeviceId,
              transferId: row.transferId,
              patch: { status: "receiving" },
              now: yield* nowIso,
            });
            return "import" as const;
          }
          yield* moves.update({
            linkDeviceId: row.linkDeviceId,
            transferId: row.transferId,
            patch: { status: "receiving" },
            now: yield* nowIso,
          });
          return "answered" as const;
        }),
      ).pipe(
        Effect.catchTags({
          PeerRpcError: () => Effect.fail(unrecorded()),
          LinkMoveRepositoryError: () => Effect.fail(unrecorded()),
        }),
      );
      if (answered === null) return false;
      if (answered === "import") yield* startImports;
      yield* announcePending;
      return true;
    });

  const respondMany: LinkMovesShape["respondMany"] = (input) =>
    Effect.gen(function* () {
      const answered: Array<ChildRequestId> = [];
      const failed: Array<{ requestId: ChildRequestId; detail: string }> = [];
      for (const requestId of new Set(input.requestIds)) {
        const one = yield* respond({
          deviceId: input.deviceId,
          requestId,
          allow: input.allow,
        }).pipe(Effect.result);
        if (one._tag === "Failure") {
          failed.push({ requestId, detail: one.failure.detail });
        } else if (one.success) {
          answered.push(requestId);
        } else {
          failed.push({ requestId, detail: "That move is no longer waiting." });
        }
      }
      return { answered, failed } satisfies ThreadMoveRespondManyResult;
    });

  const pending: LinkMovesShape["pending"] = Effect.gen(function* () {
    const open = yield* moves.listOpen.pipe(Effect.orElseSucceed(() => []));
    const result: Array<ComputerLinkPendingRequest> = [];
    for (const row of open.filter((entry) => entry.status === "awaiting_approval")) {
      const device = yield* devices
        .getDevice(row.linkDeviceId)
        .pipe(Effect.orElseSucceed(Option.none));
      const land = yield* landing(row.manifest);
      const maxRuntimeMode = Option.isSome(device)
        ? (device.value.linkMaxRuntimeMode ?? row.manifest.thread.runtimeMode)
        : row.manifest.thread.runtimeMode;
      const { runtimeMode } = clampLaunchToCeiling(
        {
          runtimeMode: row.manifest.thread.runtimeMode,
          interactionMode: row.manifest.thread.interactionMode,
        },
        { runtimeMode: maxRuntimeMode, interactionMode: row.manifest.thread.interactionMode },
      );
      const fromLabel = Option.isSome(device)
        ? device.value.label
        : row.manifest.source.environmentLabel;
      result.push({
        deviceId: row.linkDeviceId,
        requestId: row.transferId as unknown as ComputerLinkPendingRequest["requestId"],
        kind: "move",
        move: {
          messageCount: row.manifest.summary.messageCount,
          ...moveSummaryOf(row.manifest),
          ...(row.stagedApproval
            ? { bytesReceived: row.bytesReceived, totalBytes: row.manifest.totalBytes }
            : {}),
        },
        fromLabel,
        parentEnvironmentId: row.manifest.source.environmentId,
        parentThreadId: row.manifest.source.threadId,
        parentThreadTitle: row.manifest.thread.title,
        askedBy: fromLabel,
        title: row.manifest.thread.title,
        prompt: "",
        projectName: land?.project.title ?? row.manifest.project.title,
        agent: {
          instanceId: row.manifest.agent.instanceId,
          model: row.manifest.agent.model,
        },
        runtimeMode,
        createdAt: row.createdAt,
        expiresAt: DateTime.formatIso(
          DateTime.makeUnsafe(Date.parse(row.createdAt) + LINK_MOVE_TTL_MS),
        ),
      });
    }
    return result;
  });

  const dropLink: LinkMovesShape["dropLink"] = (deviceId) =>
    Effect.gen(function* () {
      const open = yield* moves.listOpen.pipe(Effect.orElseSucceed(() => []));
      // One that can't be dropped now ends anyway: its link is gone, so its
      // next stage refuses it, and the sweep drops it within the day.
      for (const row of open.filter((entry) => entry.linkDeviceId === deviceId)) {
        yield* abortMove(row.linkDeviceId, row.transferId, `${ownLabel()} removed the link.`).pipe(
          Effect.catch((error) =>
            Effect.logWarning("link move drop failed", { detail: error.message }),
          ),
        );
      }
    });

  /** Imports to finish, moves gone stale, clean-up owed, staging that can go. */
  const sweep = Effect.gen(function* () {
    const now = Date.now();
    const open = yield* moves.listOpen.pipe(Effect.orElseSucceed(() => []));
    for (const row of open) {
      if (row.status === "importing") {
        if (yield* importLanded(row)) {
          yield* settleLanded(row).pipe(Effect.ignore);
          yield* arrive(row);
        } else {
          yield* runImport(row.linkDeviceId, row.transferId).pipe(Effect.forkIn(scope));
        }
      } else if (
        !waitingToImport(row) &&
        Date.parse(row.updatedAt) +
          (row.status === "waiting_for_family" ? LINK_MOVE_FAMILY_TTL_MS : LINK_MOVE_TTL_MS) <
          now
      ) {
        yield* abortMove(
          row.linkDeviceId,
          row.transferId,
          row.status === "awaiting_approval"
            ? `Nobody on ${ownLabel()} allowed the move in time.`
            : row.status === "waiting_for_family"
              ? "The rest of its family never arrived."
              : "The move stopped arriving.",
          row.status === "awaiting_approval" ? "expired" : undefined,
        );
      }
    }
    // Moves that landed before their arrival was sent (a restart between).
    const unarrived = yield* moves.listUnarrived.pipe(Effect.orElseSucceed(() => []));
    for (const row of unarrived) yield* lock(row.transferKey)(arrive(row));
    const owed = yield* moves.listCleanupOwed.pipe(Effect.orElseSucceed(() => []));
    for (const row of owed) yield* lock(row.transferKey)(cleanUp(row));
    const settled = yield* moves
      .listSettledBefore(new Date(now - 60 * 60 * 1000).toISOString())
      .pipe(Effect.orElseSucceed(() => []));
    for (const row of settled) {
      yield* Effect.tryPromise(() =>
        NodeFs.rm(stagingDir(row), { recursive: true, force: true }),
      ).pipe(Effect.ignore);
    }
    yield* startImports;
  });

  const startReactor: LinkMovesShape["startReactor"] = () =>
    sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("link move sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
      Effect.forkScoped,
      Effect.asVoid,
    );

  /**
   * A committed move's answer says whether the thread landed as its parent's
   * child across this link (`keptParent`, docs/design/fleet.md, Part 3f,
   * (h)), and which threads it started here became its children (`adopted`,
   * Part 3f, (g)): read from the threads themselves, which only this
   * computer wrote, so a retried call (after a restart too) answers the same.
   */
  const withLanding = (link: PeerLink) => (answer: Effect.Effect<PeerMoveState, PeerRpcError>) =>
    Effect.flatMap(answer, (state) => {
      const threadId = state.threadId;
      if (state.status !== "committed" || threadId === undefined) return Effect.succeed(state);
      return Effect.gen(function* () {
        const row = yield* threadRows.getById({ threadId });
        const adopted = yield* threadRows.listAdoptedChildIds({ parentThreadId: threadId });
        return {
          ...state,
          ...(Option.isSome(row) && row.value.remoteOrigin?.linkDeviceId === link.deviceId
            ? { keptParent: true as const }
            : {}),
          ...(adopted.length > 0 ? { adopted } : {}),
        };
      }).pipe(
        // Never read as "its own thread" when it may not be: the asker tries again.
        Effect.mapError(() => peerFailure(`${ownLabel()} couldn't read its threads.`)),
      );
    });

  return LinkMoves.of({
    prepare: (link, input) => prepare(link, input).pipe(withLanding(link)),
    chunk: (link, input) => chunk(link, input).pipe(withLanding(link)),
    finish: (link, input) => finish(link, input).pipe(withLanding(link)),
    status: (link, input) => status(link, input).pipe(withLanding(link)),
    abort: (link, input) => abort(link, input).pipe(withLanding(link)),
    respond,
    respondMany,
    pending,
    pendingChanges: Stream.fromPubSub(pendingHub),
    dropLink,
    readiness,
    startReactor,
  });
});

export const LinkMovesLive = Layer.effect(LinkMoves, make);
