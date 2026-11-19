/**
 * ProjectContext: what a project keeps for the agents that work in it, kept
 * on this computer outside the orchestration event log (docs/design/
 * project-brief-notes.md): the brief, kept notes and agents' suggestions.
 * The app reads and changes them over `projectContext.*`. Agents read notes
 * and write them through `agentNotes` and `writeAgentNote` (the
 * project_note_* tools), which never touch the brief, never change what the
 * user approved, and never show a suggestion. Sessions get the brief and the
 * note list through `ProjectInstructions`.
 */
import {
  GENERAL_CHATS_PROJECT_ID,
  type LeadPassCeiling,
  PROJECT_NOTE_SUGGESTIONS_PER_PROJECT_MAX,
  PROJECT_NOTE_SUGGESTIONS_PER_THREAD_MAX,
  PROJECT_NOTES_KEPT_MAX,
  type ProjectBrief,
  type ProjectBriefSetInput,
  type ProjectBriefSetResult,
  ProjectContextError,
  type ProjectContextSnapshot,
  type ProjectId,
  type ProjectNote,
  type ProjectNoteAgentAuthor,
  ProjectNoteId,
  type ProjectNoteChange,
  type ProjectNoteChangeResult,
  type ProjectNoteListing,
  type ProjectNoteReadInput,
  type ProjectNotesMode,
  type ProjectNoteSuggestion,
  ProjectNoteSuggestionId,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectBriefRepository } from "./ProjectBriefRepository.ts";
import { ProjectNoteRepository } from "./ProjectNoteRepository.ts";
import { sameTitle, visibleNotes } from "./projectNotesAccess.ts";

/** An agent's note, as project_note_write hands it over. */
export interface AgentNoteWrite {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly summary: string;
  readonly text: string;
  readonly author: ProjectNoteAgentAuthor;
  /** The turn it was written in, so undoing that turn discards a suggestion. */
  readonly turnId: TurnId | null;
  /** The most access the writer is known to have held (see projectNoteTools). */
  readonly writerCeiling: LeadPassCeiling;
  /** The "Notes agents write" setting, read at the call. */
  readonly mode: Exclude<ProjectNotesMode, "off">;
}

export type AgentNoteWriteResult =
  | { readonly outcome: "kept_limited"; readonly detail: string }
  | { readonly outcome: "suggested"; readonly detail: string }
  | { readonly outcome: "refused"; readonly detail: string };

export interface ProjectContextShape {
  /** Every project's brief, notes and suggestions, now and again after each change. */
  readonly changes: Stream.Stream<ProjectContextSnapshot>;
  /** Save a brief, unless another device saved since `expectedRevision`. */
  readonly setBrief: (
    input: ProjectBriefSetInput,
  ) => Effect.Effect<ProjectBriefSetResult, ProjectContextError>;
  /** The project's brief text, for "Set up on another computer"; "" when it has none. */
  readonly briefText: (projectId: ProjectId) => Effect.Effect<string>;
  /**
   * A project "Set up on another computer" just added here takes the brief it
   * was copied with. Only into an empty brief: one the user wrote here wins.
   */
  readonly adoptBrief: (projectId: ProjectId, text: string) => Effect.Effect<void>;

  /** The app's own read of a note, and its changes (projectContext.readNote, changeNote). */
  readonly readNote: (
    input: ProjectNoteReadInput,
  ) => Effect.Effect<ProjectNote, ProjectContextError>;
  readonly changeNote: (
    change: ProjectNoteChange,
  ) => Effect.Effect<ProjectNoteChangeResult, ProjectContextError>;

  /** The kept notes of a project an agent running with `runtimeMode` may see, oldest first. */
  readonly agentNotes: (
    projectId: ProjectId,
    runtimeMode: RuntimeMode,
  ) => Effect.Effect<ReadonlyArray<ProjectNote>>;
  /** What an agent's write becomes (docs/design/project-brief-notes.md, "What a write becomes"). */
  readonly writeAgentNote: (input: AgentNoteWrite) => Effect.Effect<AgentNoteWriteResult>;
  /**
   * A thread's turns were undone: its suggestions from turns no longer kept
   * go. `keptTurnIds` are the thread's surviving turns.
   */
  readonly dropUndoneSuggestions: (
    threadId: ThreadId,
    keptTurnIds: ReadonlySet<TurnId>,
  ) => Effect.Effect<void>;
}

export class ProjectContext extends Context.Service<ProjectContext, ProjectContextShape>()(
  "threadlines/projectContext/ProjectContext",
) {}

const failWith = (detail: string) => Effect.fail(new ProjectContextError({ detail }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const emptyBrief = (projectId: ProjectId): ProjectBrief => ({
  projectId,
  text: "",
  revision: 0,
  updatedAt: null,
});

const listing = ({ text: _text, ...note }: ProjectNote): ProjectNoteListing => note;

const fullDetail = (count: number) =>
  `This project keeps at most ${count} notes. Remove one first.`;

export const makeProjectContext = Effect.gen(function* () {
  const briefs = yield* ProjectBriefRepository;
  const noteRows = yield* ProjectNoteRepository;
  const projects = yield* ProjectionProjectRepository;

  const loadOr = <A, E>(read: Effect.Effect<A, E>, fallback: A, what: string) =>
    read.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`${what} could not be read`, { cause: Cause.pretty(cause) }).pipe(
          Effect.as(fallback),
        ),
      ),
    );
  /** Kept notes with their text; small (at most PROJECT_NOTES_KEPT_MAX a project). */
  const notes = yield* Ref.make<ReadonlyArray<ProjectNote>>(
    yield* loadOr(noteRows.listNotes(), [], "project notes"),
  );
  const suggestions = yield* Ref.make<ReadonlyArray<ProjectNoteSuggestion>>(
    yield* loadOr(noteRows.listSuggestions(), [], "project note suggestions"),
  );
  const initialBriefs = yield* loadOr(briefs.listAll(), [], "project briefs");
  const snapshotOf = (
    briefList: ReadonlyArray<ProjectBrief>,
    noteList: ReadonlyArray<ProjectNote>,
    suggestionList: ReadonlyArray<ProjectNoteSuggestion>,
  ): ProjectContextSnapshot => ({
    briefs: briefList,
    notes: noteList.map(listing),
    suggestions: suggestionList,
  });
  const snapshot = yield* SubscriptionRef.make<ProjectContextSnapshot>(
    snapshotOf(initialBriefs, yield* Ref.get(notes), yield* Ref.get(suggestions)),
  );
  const publishBrief = (brief: ProjectBrief) =>
    SubscriptionRef.update(snapshot, (current) => ({
      ...current,
      briefs: [...current.briefs.filter((entry) => entry.projectId !== brief.projectId), brief],
    }));
  const publishNotes = Effect.gen(function* () {
    const noteList = yield* Ref.get(notes);
    const suggestionList = yield* Ref.get(suggestions);
    yield* SubscriptionRef.update(snapshot, (current) =>
      snapshotOf(current.briefs, noteList, suggestionList),
    );
  });

  /** Notes and suggestions change one at a time, so limits and titles are checked against what is there. */
  const noteLock = yield* Semaphore.make(1);
  const locked = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(noteLock.withPermits(1), Effect.ensuring(publishNotes));

  const storageError = (what: string) => (cause: unknown) =>
    Effect.logWarning(`project notes: ${what} failed`, { cause: String(cause) }).pipe(
      Effect.andThen(failWith(`The note couldn't be ${what}.`)),
    );

  const requireProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      if (projectId === GENERAL_CHATS_PROJECT_ID) {
        return yield* failWith("General Chats have no brief or notes.");
      }
      const project = yield* projects
        .getById({ projectId })
        .pipe(
          Effect.mapError(
            () => new ProjectContextError({ detail: "The project couldn't be read." }),
          ),
        );
      if (Option.isNone(project) || project.value.deletedAt !== null) {
        return yield* failWith("This project is gone.");
      }
    });

  const setBrief: ProjectContextShape["setBrief"] = (input) =>
    Effect.gen(function* () {
      yield* requireProject(input.projectId);
      const saved = yield* briefs
        .save({
          projectId: input.projectId,
          text: input.text,
          expectedRevision: input.expectedRevision,
          now: yield* nowIso,
        })
        .pipe(
          Effect.mapError(
            () => new ProjectContextError({ detail: "The brief couldn't be saved." }),
          ),
        );
      if (Option.isNone(saved)) {
        const current = yield* briefs
          .get(input.projectId)
          .pipe(
            Effect.mapError(
              () => new ProjectContextError({ detail: "The brief couldn't be read." }),
            ),
          );
        return {
          outcome: "stale" as const,
          brief: Option.getOrElse(current, () => emptyBrief(input.projectId)),
        };
      }
      yield* publishBrief(saved.value);
      return { outcome: "saved" as const, brief: saved.value };
    });

  const briefText: ProjectContextShape["briefText"] = (projectId) =>
    briefs.get(projectId).pipe(
      Effect.map((row) => Option.getOrUndefined(row)?.text ?? ""),
      Effect.orElseSucceed(() => ""),
    );

  const adoptBrief: ProjectContextShape["adoptBrief"] = (projectId, text) =>
    Effect.gen(function* () {
      if (text.trim().length === 0) return;
      const saved = yield* briefs.save({
        projectId,
        text,
        expectedRevision: 0,
        now: yield* nowIso,
      });
      if (Option.isSome(saved)) yield* publishBrief(saved.value);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("a copied project's brief couldn't be saved", {
          projectId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const findNote = (projectId: ProjectId, noteId: ProjectNoteId) =>
    Effect.gen(function* () {
      const note = (yield* Ref.get(notes)).find(
        (entry) => entry.id === noteId && entry.projectId === projectId,
      );
      return note === undefined ? yield* failWith("This note is gone.") : note;
    });

  const keptIn = (projectId: ProjectId) =>
    Effect.map(Ref.get(notes), (all) => all.filter((note) => note.projectId === projectId));

  /** Stores the note and the in-memory list together. */
  const putNote = (note: ProjectNote) =>
    noteRows
      .putNote(note)
      .pipe(
        Effect.andThen(
          Ref.update(notes, (all) =>
            all.some((entry) => entry.id === note.id)
              ? all.map((entry) => (entry.id === note.id ? note : entry))
              : [...all, note],
          ),
        ),
      );

  const readNote: ProjectContextShape["readNote"] = (input) =>
    findNote(input.projectId, input.noteId);

  const saveNote = (input: Extract<ProjectNoteChange, { kind: "save" }>) =>
    locked(
      Effect.gen(function* () {
        yield* requireProject(input.projectId);
        const kept = yield* keptIn(input.projectId);
        const existing =
          input.noteId === undefined ? undefined : yield* findNote(input.projectId, input.noteId);
        if (kept.some((note) => note.id !== existing?.id && sameTitle(note.title, input.title))) {
          return yield* failWith("Another note has this title.");
        }
        if (existing === undefined && kept.length >= PROJECT_NOTES_KEPT_MAX) {
          return yield* failWith(fullDetail(PROJECT_NOTES_KEPT_MAX));
        }
        const now = yield* nowIso;
        const note: ProjectNote = {
          id: existing?.id ?? ProjectNoteId.make(crypto.randomUUID()),
          projectId: input.projectId,
          title: input.title,
          summary: input.summary,
          text: input.text,
          // The user wrote or read it: every thread sees it.
          approved: true,
          writerCeiling: null,
          author: existing?.author ?? { kind: "user" },
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        yield* putNote(note).pipe(Effect.catch(storageError("saved")));
        return note;
      }),
    );

  const removeNote = (input: ProjectNoteReadInput) =>
    locked(
      Effect.gen(function* () {
        const note = yield* findNote(input.projectId, input.noteId);
        yield* noteRows.deleteNote(note.id).pipe(Effect.catch(storageError("removed")));
        yield* Ref.update(notes, (all) => all.filter((entry) => entry.id !== note.id));
      }),
    );

  const approveNote = (input: ProjectNoteReadInput) =>
    locked(
      Effect.gen(function* () {
        const note = yield* findNote(input.projectId, input.noteId);
        if (note.approved) return;
        yield* putNote({
          ...note,
          approved: true,
          writerCeiling: null,
          updatedAt: yield* nowIso,
        }).pipe(Effect.catch(storageError("approved")));
      }),
    );

  const removeSuggestions = (ids: ReadonlyArray<ProjectNoteSuggestionId>) =>
    noteRows
      .deleteSuggestions(ids)
      .pipe(
        Effect.andThen(
          Ref.update(suggestions, (all) => all.filter((entry) => !ids.includes(entry.id))),
        ),
      );

  const resolveSuggestion = (
    input: Extract<ProjectNoteChange, { kind: "resolveSuggestion" }>,
  ): Effect.Effect<ProjectNote | null, ProjectContextError> =>
    locked(
      Effect.gen(function* () {
        const suggestion = (yield* Ref.get(suggestions)).find(
          (entry) => entry.id === input.suggestionId && entry.projectId === input.projectId,
        );
        if (suggestion === undefined) return yield* failWith("This suggestion is gone.");
        if (input.decision === "discard") {
          yield* removeSuggestions([suggestion.id]).pipe(Effect.catch(storageError("discarded")));
          return null;
        }
        yield* requireProject(suggestion.projectId);
        const kept = yield* keptIn(suggestion.projectId);
        const replaces = kept.find((note) => sameTitle(note.title, suggestion.title));
        if (replaces === undefined && kept.length >= PROJECT_NOTES_KEPT_MAX) {
          return yield* failWith(fullDetail(PROJECT_NOTES_KEPT_MAX));
        }
        const now = yield* nowIso;
        const note: ProjectNote = {
          id: replaces?.id ?? ProjectNoteId.make(crypto.randomUUID()),
          projectId: suggestion.projectId,
          title: suggestion.title,
          summary: suggestion.summary,
          text: suggestion.text,
          // The user read exactly this text and kept it.
          approved: true,
          writerCeiling: null,
          author: suggestion.author,
          createdAt: replaces?.createdAt ?? now,
          updatedAt: now,
        };
        yield* noteRows
          .transaction(
            noteRows
              .putNote(note)
              .pipe(Effect.andThen(noteRows.deleteSuggestions([suggestion.id]))),
          )
          .pipe(Effect.catch(storageError("kept")));
        yield* Ref.update(notes, (all) =>
          replaces === undefined
            ? [...all, note]
            : all.map((entry) => (entry.id === note.id ? note : entry)),
        );
        yield* Ref.update(suggestions, (all) => all.filter((entry) => entry.id !== suggestion.id));
        return note;
      }),
    );

  const changeNote: ProjectContextShape["changeNote"] = (change) => {
    switch (change.kind) {
      case "save":
        return Effect.map(saveNote(change), (note) => ({ note }));
      case "remove":
        return Effect.as(removeNote(change), { note: null });
      case "approve":
        return Effect.as(approveNote(change), { note: null });
      case "resolveSuggestion":
        return Effect.map(resolveSuggestion(change), (note) => ({ note }));
    }
  };

  const agentNotes: ProjectContextShape["agentNotes"] = (projectId, runtimeMode) =>
    Effect.map(Ref.get(notes), (all) => visibleNotes(all, projectId, runtimeMode));

  const suggest = (input: AgentNoteWrite, replaces: boolean) =>
    Effect.gen(function* () {
      const waiting = (yield* Ref.get(suggestions)).filter(
        (entry) => entry.projectId === input.projectId,
      );
      // Only the writer's own count is named: other threads' writes stay theirs.
      if (
        waiting.filter((entry) => entry.author.threadId === input.author.threadId).length >=
        PROJECT_NOTE_SUGGESTIONS_PER_THREAD_MAX
      ) {
        return {
          outcome: "refused" as const,
          detail: `This thread has ${PROJECT_NOTE_SUGGESTIONS_PER_THREAD_MAX} notes waiting for the user. Ask them to keep or discard some first.`,
        };
      }
      if (waiting.length >= PROJECT_NOTE_SUGGESTIONS_PER_PROJECT_MAX) {
        return {
          outcome: "refused" as const,
          detail:
            "This project can take no more suggested notes until the user reviews some. Tell the user instead.",
        };
      }
      const suggestion: ProjectNoteSuggestion = {
        id: ProjectNoteSuggestionId.make(crypto.randomUUID()),
        projectId: input.projectId,
        title: input.title,
        summary: input.summary,
        text: input.text,
        author: input.author,
        turnId: input.turnId,
        createdAt: yield* nowIso,
      };
      yield* noteRows.insertSuggestion(suggestion);
      yield* Ref.update(suggestions, (all) => [...all, suggestion]);
      return {
        outcome: "suggested" as const,
        detail: replaces
          ? "A note with this title already exists. Yours waits for the user, who keeps it in place of that one or discards it. Until then threads see the existing note."
          : "Your note waits for the user to keep or discard. Other threads see it once it is kept.",
      };
    });

  const writeAgentNote: ProjectContextShape["writeAgentNote"] = (input) =>
    locked(
      Effect.gen(function* () {
        const kept = yield* keptIn(input.projectId);
        const existing = kept.find((note) => sameTitle(note.title, input.title));
        if (existing !== undefined) {
          // A thread may rewrite a limited note it wrote itself; any other
          // note with this title stays as it is until the user says.
          const ownLimited =
            input.mode === "auto" &&
            !existing.approved &&
            existing.author.kind === "agent" &&
            existing.author.threadId === input.author.threadId;
          if (!ownLimited) return yield* suggest(input, true);
          yield* putNote({
            ...existing,
            title: input.title,
            summary: input.summary,
            text: input.text,
            writerCeiling: input.writerCeiling,
            author: input.author,
            updatedAt: yield* nowIso,
          });
          return {
            outcome: "kept_limited" as const,
            detail:
              "Your note is updated. Threads with more access than this one don't see it until the user shows it to all threads.",
          };
        }
        if (input.mode === "ask") return yield* suggest(input, false);
        if (kept.length >= PROJECT_NOTES_KEPT_MAX) {
          return {
            outcome: "refused" as const,
            detail:
              "This project can take no more notes until the user removes some. Tell the user instead.",
          };
        }
        const now = yield* nowIso;
        yield* putNote({
          id: ProjectNoteId.make(crypto.randomUUID()),
          projectId: input.projectId,
          title: input.title,
          summary: input.summary,
          text: input.text,
          approved: false,
          writerCeiling: input.writerCeiling,
          author: input.author,
          createdAt: now,
          updatedAt: now,
        });
        return {
          outcome: "kept_limited" as const,
          detail:
            "Your note is kept. Threads with more access than this one don't see it until the user shows it to all threads.",
        };
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("an agent's project note couldn't be written", {
          projectId: input.projectId,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.as({
            outcome: "refused" as const,
            detail: "The note couldn't be saved. Try again.",
          }),
        ),
      ),
    );

  const dropUndoneSuggestions: ProjectContextShape["dropUndoneSuggestions"] = (
    threadId,
    keptTurnIds,
  ) =>
    locked(
      Effect.gen(function* () {
        const undone = (yield* Ref.get(suggestions)).filter(
          (entry) =>
            entry.author.threadId === threadId &&
            entry.turnId !== null &&
            !keptTurnIds.has(entry.turnId),
        );
        if (undone.length > 0) yield* removeSuggestions(undone.map((entry) => entry.id));
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("an undone turn's note suggestions couldn't be discarded", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  return {
    changes: SubscriptionRef.changes(snapshot),
    setBrief,
    briefText,
    adoptBrief,
    readNote,
    changeNote,
    agentNotes,
    writeAgentNote,
    dropUndoneSuggestions,
  } satisfies ProjectContextShape;
});

export const ProjectContextLive = Layer.effect(ProjectContext, makeProjectContext);
