/**
 * A project's brief: text the user writes once, which every thread in the
 * project gets as standing instructions, on any agent (docs/design/
 * project-brief-notes.md). Kept by Threadlines on each computer, outside the
 * orchestration event log and outside the repository.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProjectNoteId,
  ProjectNoteSuggestionId,
  ThreadId,
  ThreadParticipantId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { LeadPassCeiling } from "./orchestration.ts";

/** The longest brief a project keeps. */
export const PROJECT_BRIEF_MAX_CHARS = 8_000;

/**
 * A project's brief on one computer. `revision` counts its saves there, so a
 * save from a page that loaded an older one is refused instead of lost.
 */
export const ProjectBrief = Schema.Struct({
  projectId: ProjectId,
  /** "" when the project has none. */
  text: Schema.String,
  revision: NonNegativeInt,
  /** Null before the first save. */
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectBrief = typeof ProjectBrief.Type;

/*
 * Project notes: short notes agents write while they work, which later
 * threads in the project read (docs/design/project-brief-notes.md). Kept on
 * the computer whose agents wrote them. An agent's note is a suggestion the
 * user keeps or discards, or, with "Keep without asking", a note kept at once
 * but shown only to agents within its writer's access until the user
 * approves it for all.
 */

export const PROJECT_NOTE_TITLE_MAX_CHARS = 80;
export const PROJECT_NOTE_SUMMARY_MAX_CHARS = 200;
export const PROJECT_NOTE_TEXT_MAX_CHARS = 8_000;
/** Kept notes a project holds. */
export const PROJECT_NOTES_KEPT_MAX = 60;
/** Suggestions waiting for the user, from one thread and in one project. */
export const PROJECT_NOTE_SUGGESTIONS_PER_THREAD_MAX = 5;
export const PROJECT_NOTE_SUGGESTIONS_PER_PROJECT_MAX = 40;

/** Whether agents may write notes, and what their writes become. Never chosen: `ask`. */
export const ProjectNotesMode = Schema.Literals(["off", "ask", "auto"]);
export type ProjectNotesMode = typeof ProjectNotesMode.Type;

export const ProjectNoteTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_NOTE_TITLE_MAX_CHARS),
);
export const ProjectNoteSummary = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_NOTE_SUMMARY_MAX_CHARS),
);
export const ProjectNoteText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_NOTE_TEXT_MAX_CHARS),
);

/** An agent that wrote a note: its thread, which of the thread's agents, and its name then. */
export const ProjectNoteAgentAuthor = Schema.Struct({
  kind: Schema.Literal("agent"),
  threadId: ThreadId,
  /** Null: the thread's own agent. */
  participantId: Schema.NullOr(ThreadParticipantId),
  agentName: Schema.String,
});
export type ProjectNoteAgentAuthor = typeof ProjectNoteAgentAuthor.Type;

export const ProjectNoteAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  ProjectNoteAgentAuthor,
]);
export type ProjectNoteAuthor = typeof ProjectNoteAuthor.Type;

/** A kept note as the app lists it: everything but its text (projectContext.readNote). */
export const ProjectNoteListing = Schema.Struct({
  id: ProjectNoteId,
  projectId: ProjectId,
  title: ProjectNoteTitle,
  summary: ProjectNoteSummary,
  /** The user wrote it, kept it, or showed it to all threads. */
  approved: Schema.Boolean,
  /**
   * An agent's note kept without asking: the most access an agent may run
   * with and still be shown it. Null once approved, and for the user's own.
   */
  writerCeiling: Schema.NullOr(LeadPassCeiling),
  author: ProjectNoteAuthor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectNoteListing = typeof ProjectNoteListing.Type;

export const ProjectNote = Schema.Struct({
  ...ProjectNoteListing.fields,
  text: ProjectNoteText,
});
export type ProjectNote = typeof ProjectNote.Type;

/**
 * An agent's note waiting for the user. Never changed once written: Keep and
 * Discard name its id, so the user keeps exactly the text they read. A second
 * write of the same title is a second suggestion.
 */
export const ProjectNoteSuggestion = Schema.Struct({
  id: ProjectNoteSuggestionId,
  projectId: ProjectId,
  title: ProjectNoteTitle,
  summary: ProjectNoteSummary,
  text: ProjectNoteText,
  author: ProjectNoteAgentAuthor,
  /** The turn that wrote it; undoing that turn discards it. Null: written outside a turn. */
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
});
export type ProjectNoteSuggestion = typeof ProjectNoteSuggestion.Type;

const emptyList = <S extends Schema.Top>(item: S) =>
  Schema.Array(item).pipe(Schema.withDecodingDefault(Effect.succeed([])));

/**
 * What `projectContext.subscribe` sends: every project's brief that has one,
 * its kept notes without their text, and the suggestions waiting. An older
 * server sends no notes.
 */
export const ProjectContextSnapshot = Schema.Struct({
  briefs: Schema.Array(ProjectBrief),
  notes: emptyList(ProjectNoteListing),
  suggestions: emptyList(ProjectNoteSuggestion),
});
export type ProjectContextSnapshot = typeof ProjectContextSnapshot.Type;

export const ProjectContextSubscribeInput = Schema.Struct({});
export type ProjectContextSubscribeInput = typeof ProjectContextSubscribeInput.Type;

/**
 * Save a project's brief. `expectedRevision` is the revision the page last saw
 * on this computer; a save from behind another device's is refused (`stale`)
 * with the brief as it is now. "" clears it.
 */
export const ProjectBriefSetInput = Schema.Struct({
  projectId: ProjectId,
  text: Schema.String.check(Schema.isMaxLength(PROJECT_BRIEF_MAX_CHARS)),
  expectedRevision: NonNegativeInt,
});
export type ProjectBriefSetInput = typeof ProjectBriefSetInput.Type;

export const ProjectBriefSetResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("saved"), brief: ProjectBrief }),
  /** Another device saved first: nothing was written, and `brief` is theirs. */
  Schema.Struct({ outcome: Schema.Literal("stale"), brief: ProjectBrief }),
]);
export type ProjectBriefSetResult = typeof ProjectBriefSetResult.Type;

export const ProjectNoteReadInput = Schema.Struct({
  projectId: ProjectId,
  noteId: ProjectNoteId,
});
export type ProjectNoteReadInput = typeof ProjectNoteReadInput.Type;

/**
 * The user writes a note, or edits one (`noteId`). Kept and approved: it is
 * shown to every thread. Titles are unique among a project's kept notes.
 */
export const ProjectNoteSaveInput = Schema.Struct({
  projectId: ProjectId,
  noteId: Schema.optional(ProjectNoteId),
  title: ProjectNoteTitle,
  summary: ProjectNoteSummary,
  text: ProjectNoteText,
});
export type ProjectNoteSaveInput = typeof ProjectNoteSaveInput.Type;

export const ProjectNoteRemoveInput = ProjectNoteReadInput;
export type ProjectNoteRemoveInput = typeof ProjectNoteRemoveInput.Type;

/** "Show to all threads": a note kept without asking reaches every thread. */
export const ProjectNoteApproveInput = ProjectNoteReadInput;
export type ProjectNoteApproveInput = typeof ProjectNoteApproveInput.Type;

/**
 * Keep or discard one suggestion. Keep makes it a kept, approved note, in
 * place of a kept note with the same title.
 */
export const ProjectNoteSuggestionResolveInput = Schema.Struct({
  projectId: ProjectId,
  suggestionId: ProjectNoteSuggestionId,
  decision: Schema.Literals(["keep", "discard"]),
});
export type ProjectNoteSuggestionResolveInput = typeof ProjectNoteSuggestionResolveInput.Type;

export class ProjectContextError extends Schema.TaggedError<ProjectContextError>()(
  "ProjectContextError",
  { detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return this.detail;
  }
}
