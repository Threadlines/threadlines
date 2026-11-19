/**
 * Settings › Instructions › Notes (docs/design/project-brief-notes.md): the
 * picked project's notes on the picked computer only (notes don't sync
 * between computers), the suggestions waiting there, and the one setting for
 * what agents' notes become. Shown only when that computer keeps notes.
 *
 * Mount it keyed by the picked project: a pick starts with nothing open.
 */
import {
  type EnvironmentId,
  PROJECT_NOTE_SUMMARY_MAX_CHARS,
  PROJECT_NOTE_TEXT_MAX_CHARS,
  PROJECT_NOTE_TITLE_MAX_CHARS,
  type ProjectId,
  type ProjectNoteAuthor,
  type ProjectNoteId,
  type ProjectNoteListing,
  type ProjectNoteSuggestion,
  type ThreadId,
} from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import { PROJECT_NOTES_MODE_LABELS } from "@threadlines/shared/appPlaces";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, LoaderIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { computerInSentence } from "../../projectBrief";
import {
  changeProjectNote,
  noteActionErrorText,
  readProjectNote,
  useProjectContextSnapshots,
} from "../../projectContext";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeTimeLabel } from "../RelativeTimeLabel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  SETTINGS_GROUP_ROW_CLASS,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

/** What a note kept without asking says until the user shows it to all threads. */
export const LIMITED_NOTE_LINE =
  "Kept automatically. Threads with more access than its writer do not see it.";

/** A thread's title by its computer and id; null when this app doesn't list it. */
export type ThreadTitleLookup = (environmentId: EnvironmentId, threadId: ThreadId) => string | null;

export function ProjectNotesSection({
  environmentId,
  projectId,
  supported,
  threadTitle,
  ownComputer,
  ownComputerLabel,
}: {
  /** The picked project's computer: the notes listed are the ones kept there. */
  environmentId: EnvironmentId;
  projectId: ProjectId;
  /** That computer's server keeps notes (the `projectContext` capability). */
  supported: boolean;
  threadTitle: ThreadTitleLookup;
  /** The picked computer is the one this app's settings belong to. */
  ownComputer: boolean;
  /** This app's own computer, as the page names it. */
  ownComputerLabel: string;
}) {
  const following = useMemo(() => (supported ? [environmentId] : []), [environmentId, supported]);
  const snapshot = useProjectContextSnapshots(following)[environmentId];
  const notes = useMemo(
    () =>
      (snapshot?.notes ?? [])
        .filter((note) => note.projectId === projectId)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [projectId, snapshot],
  );
  const suggestions = useMemo(
    () =>
      (snapshot?.suggestions ?? [])
        .filter((suggestion) => suggestion.projectId === projectId)
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [projectId, snapshot],
  );
  const [adding, setAdding] = useState(false);
  /** The one row open: "note:<id>" or "suggestion:<id>". */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (key: string) => setOpenKey((current) => (current === key ? null : key));

  if (!supported) return null;

  const loaded = snapshot !== undefined;
  const empty = loaded && notes.length === 0 && suggestions.length === 0;

  return (
    <SettingsSection
      place="instructions.notes"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!loaded || adding}
          onClick={() => {
            setAdding(true);
            setOpenKey(null);
          }}
        >
          <PlusIcon className="size-3.5" />
          Add note
        </Button>
      }
    >
      <ProjectNotesModeRow ownComputer={ownComputer} ownComputerLabel={ownComputerLabel} />
      {adding ? (
        <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-3")}>
          <NoteForm
            initial={null}
            submitLabel="Save note"
            onCancel={() => setAdding(false)}
            onSubmit={async (fields) => {
              await changeProjectNote(environmentId, { kind: "save", projectId, ...fields });
              setAdding(false);
            }}
          />
        </div>
      ) : null}
      {suggestions.map((suggestion) => (
        <SuggestionRow
          key={suggestion.id}
          environmentId={environmentId}
          suggestion={suggestion}
          open={openKey === `suggestion:${suggestion.id}`}
          onToggle={() => toggle(`suggestion:${suggestion.id}`)}
          threadTitle={threadTitle}
        />
      ))}
      {notes.map((note) => (
        <KeptNoteRow
          key={note.id}
          environmentId={environmentId}
          note={note}
          open={openKey === `note:${note.id}`}
          onToggle={() => toggle(`note:${note.id}`)}
          onClose={() => setOpenKey(null)}
          threadTitle={threadTitle}
        />
      ))}
      {!loaded ? (
        <p className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5 text-xs text-muted-foreground")}>
          Loading notes…
        </p>
      ) : empty && !adding ? (
        <p
          className={cn(
            SETTINGS_GROUP_ROW_CLASS,
            "px-3.5 py-2.5 text-[12.5px] leading-[18px] text-muted-foreground",
          )}
        >
          No notes yet. Agents leave notes here for later threads in this project, and you can add
          your own. Notes stay on this computer.
        </p>
      ) : null}
    </SettingsSection>
  );
}

/**
 * "Notes agents write": one setting for every project on this app's own
 * computer. On the notes of another computer's project it says whose it is.
 */
export function ProjectNotesModeRow({
  ownComputer = true,
  ownComputerLabel = "This device",
}: {
  ownComputer?: boolean;
  ownComputerLabel?: string;
}) {
  const mode = useSettings((settings) => settings.projectNotes);
  const { updateSettings } = useUpdateSettings();
  const what =
    mode === "off"
      ? "Agents don't write notes. Kept notes still reach new threads."
      : mode === "auto"
        ? "An agent's note is kept at once, but only threads with no more access than its writer see it until you show it to all."
        : "Each note an agent writes waits here, and in its thread, until you keep or discard it.";
  return (
    <SettingsRow
      place="instructions.notesMode"
      description={
        ownComputer
          ? what
          : `${what} This sets it on ${computerInSentence(ownComputerLabel)}. Each computer has its own.`
      }
      resetAction={
        mode !== "ask" ? (
          <SettingResetButton
            label="notes agents write"
            onClick={() => updateSettings({ projectNotes: "ask" })}
          />
        ) : null
      }
      control={
        <Select
          value={mode}
          onValueChange={(value) => {
            if (value === "off" || value === "ask" || value === "auto") {
              updateSettings({ projectNotes: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Notes agents write">
            <SelectValue>{PROJECT_NOTES_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="off">{PROJECT_NOTES_MODE_LABELS.off}</SelectItem>
            <SelectItem value="ask">{PROJECT_NOTES_MODE_LABELS.ask}</SelectItem>
            <SelectItem value="auto">{PROJECT_NOTES_MODE_LABELS.auto}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** Who wrote a note (its thread, linked, and the agent's name; or "You") and when. */
function NoteByline({
  environmentId,
  author,
  at,
  threadTitle,
}: {
  environmentId: EnvironmentId;
  author: ProjectNoteAuthor;
  at: string;
  threadTitle: ThreadTitleLookup;
}) {
  const title = author.kind === "agent" ? threadTitle(environmentId, author.threadId) : null;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
      {author.kind === "user" ? (
        <span className="shrink-0">You</span>
      ) : (
        <>
          {title !== null ? (
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(environmentId, author.threadId))}
              className="min-w-0 truncate rounded-sm underline decoration-dotted underline-offset-[3px] transition-colors hover:text-foreground focus-ring"
            >
              {title}
            </Link>
          ) : null}
          {title !== null ? <span aria-hidden>·</span> : null}
          <span className="shrink-0">{author.agentName}</span>
        </>
      )}
      <span aria-hidden>·</span>
      <time
        dateTime={at}
        title={new Date(at).toLocaleString()}
        className="shrink-0 font-mono tabular-nums"
      >
        <RelativeTimeLabel at={at} />
      </time>
    </p>
  );
}

/** A note's title and one line, as a button that opens or closes the row. */
function NoteHeading({
  title,
  summary,
  open,
  onToggle,
  badge,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="group/note-heading flex w-full min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-sm text-left focus-ring"
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
          {title}
        </span>
        {badge}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/note-heading:text-foreground",
            open && "rotate-90",
          )}
        />
      </span>
      <span className="w-full min-w-0 truncate text-[12.5px] leading-[18px] text-muted-foreground">
        {summary}
      </span>
    </button>
  );
}

/** An action's failure, in the row it came from. */
function RowError({ text }: { text: string | null }) {
  return text === null ? null : (
    <p role="alert" className="text-xs leading-[18px] text-destructive-foreground">
      {text}
    </p>
  );
}

/** A note's text as the user reads it before keeping it, or an open note's. */
function NoteText({ text }: { text: string }) {
  return (
    <p className="max-h-72 overflow-y-auto rounded-lg bg-muted/50 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
      {text}
    </p>
  );
}

function SuggestionRow({
  environmentId,
  suggestion,
  open,
  onToggle,
  threadTitle,
}: {
  environmentId: EnvironmentId;
  suggestion: ProjectNoteSuggestion;
  open: boolean;
  onToggle: () => void;
  threadTitle: ThreadTitleLookup;
}) {
  const [pending, setPending] = useState<"keep" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (decision: "keep" | "discard") => {
    setPending(decision);
    setError(null);
    try {
      // The row leaves when the snapshot drops the suggestion.
      await changeProjectNote(environmentId, {
        kind: "resolveSuggestion",
        projectId: suggestion.projectId,
        suggestionId: suggestion.id,
        decision,
      });
    } catch (cause) {
      setError(noteActionErrorText(cause));
    } finally {
      setPending(null);
    }
  };
  return (
    <div
      className={cn(SETTINGS_GROUP_ROW_CLASS, "flex flex-col gap-1.5 px-3.5 py-2.5")}
      data-note-suggestion={suggestion.id}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <NoteHeading
            title={suggestion.title}
            summary={suggestion.summary}
            open={open}
            onToggle={onToggle}
            badge={
              <Badge variant="info" size="sm">
                Suggested
              </Badge>
            }
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            aria-label={`Discard ${suggestion.title}`}
            disabled={pending !== null}
            onClick={() => void resolve("discard")}
          >
            {pending === "discard" ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Discard
          </Button>
          <Button
            size="xs"
            aria-label={`Keep ${suggestion.title}`}
            disabled={pending !== null}
            onClick={() => void resolve("keep")}
          >
            {pending === "keep" ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Keep
          </Button>
        </div>
      </div>
      <NoteByline
        environmentId={environmentId}
        author={suggestion.author}
        at={suggestion.createdAt}
        threadTitle={threadTitle}
      />
      {open ? <NoteText text={suggestion.text} /> : null}
      <RowError text={error} />
    </div>
  );
}

function KeptNoteRow({
  environmentId,
  note,
  open,
  onToggle,
  onClose,
  threadTitle,
}: {
  environmentId: EnvironmentId;
  note: ProjectNoteListing;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  threadTitle: ThreadTitleLookup;
}) {
  const limited = !note.approved && note.writerCeiling !== null;
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The version of the text the open note shows; null while it is closed or loading. */
  const [shownVersion, setShownVersion] = useState<string | null>(null);
  const approve = async () => {
    setApproving(true);
    setError(null);
    try {
      await changeProjectNote(environmentId, {
        kind: "approve",
        projectId: note.projectId,
        noteId: note.id,
        // The version the user can see: the open note's text, else this row.
        // One its writer rewrote since is refused, so it is read again first.
        updatedAt: open && shownVersion !== null ? shownVersion : note.updatedAt,
      });
    } catch (cause) {
      setError(noteActionErrorText(cause));
    } finally {
      setApproving(false);
    }
  };
  return (
    <div
      className={cn(SETTINGS_GROUP_ROW_CLASS, "flex flex-col gap-1.5 px-3.5 py-2.5")}
      data-project-note={note.id}
    >
      <NoteHeading title={note.title} summary={note.summary} open={open} onToggle={onToggle} />
      <NoteByline
        environmentId={environmentId}
        author={note.author}
        at={note.updatedAt}
        threadTitle={threadTitle}
      />
      {limited ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-xs leading-[18px] text-muted-foreground">{LIMITED_NOTE_LINE}</p>
          <Button size="xs" variant="outline" disabled={approving} onClick={() => void approve()}>
            {approving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Show to all threads
          </Button>
        </div>
      ) : null}
      <RowError text={error} />
      {open ? (
        <OpenNote
          key={note.id}
          environmentId={environmentId}
          note={note}
          limited={limited}
          onClose={onClose}
          onShown={setShownVersion}
        />
      ) : null}
    </div>
  );
}

/**
 * An open note: its text, read from its computer, to edit or remove. Mount
 * it keyed by the note's id: a change made elsewhere while it is open keeps
 * the user's draft and says the note changed, rather than wiping the form.
 */
function OpenNote({
  environmentId,
  note,
  limited,
  onClose,
  onShown,
}: {
  environmentId: EnvironmentId;
  note: ProjectNoteListing;
  limited: boolean;
  onClose: () => void;
  /** The version of the text now on screen, as read or saved here. */
  onShown: (version: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  /** The version the form started from, or last saved here. */
  const [openedAt, setOpenedAt] = useState(note.updatedAt);
  const changedElsewhere = note.updatedAt !== openedAt;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const noteId: ProjectNoteId = note.id;
  const projectId = note.projectId;

  useEffect(() => {
    let cancelled = false;
    readProjectNote(environmentId, { projectId, noteId }).then(
      (read) => {
        if (cancelled) return;
        setText(read.text);
        setOpenedAt(read.updatedAt);
        onShown(read.updatedAt);
      },
      (cause: unknown) => {
        if (!cancelled) setLoadError(noteActionErrorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, noteId, projectId, onShown]);

  const remove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      await changeProjectNote(environmentId, { kind: "remove", projectId, noteId });
      onClose();
    } catch (cause) {
      setRemoveError(noteActionErrorText(cause));
      setRemoving(false);
    }
  };

  if (loadError !== null) return <RowError text={loadError} />;
  if (text === null) {
    return <p className="text-xs text-muted-foreground">Loading the note…</p>;
  }
  return (
    <div className="flex flex-col gap-2 pt-1">
      <NoteForm
        initial={{ title: note.title, summary: note.summary, text }}
        submitLabel="Save"
        {...(changedElsewhere
          ? { hint: "This note changed since you opened it. Saving replaces the newer text." }
          : limited
            ? { hint: "Saving it shows it to all threads." }
            : {})}
        onCancel={onClose}
        onSubmit={async (fields) => {
          const saved = await changeProjectNote(environmentId, {
            kind: "save",
            projectId,
            noteId,
            ...fields,
          });
          if (saved !== null) {
            setText(saved.text);
            setOpenedAt(saved.updatedAt);
            onShown(saved.updatedAt);
          }
        }}
        extraAction={
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Remove
          </Button>
        }
      />
      <RowError text={removeError} />
    </div>
  );
}

interface NoteFields {
  readonly title: string;
  readonly summary: string;
  readonly text: string;
}

const FIELD_LABEL = "text-xs font-medium text-muted-foreground";

/** The user's note: a title, its one line and its text, each within its limit. */
function NoteForm({
  initial,
  submitLabel,
  hint,
  onSubmit,
  onCancel,
  extraAction,
}: {
  initial: NoteFields | null;
  submitLabel: string;
  hint?: string;
  onSubmit: (fields: NoteFields) => Promise<void>;
  onCancel: () => void;
  extraAction?: ReactNode;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields: NoteFields = { title: title.trim(), summary: summary.trim(), text: text.trim() };
  const complete = fields.title !== "" && fields.summary !== "" && fields.text !== "";
  const changed =
    initial === null ||
    fields.title !== initial.title ||
    fields.summary !== initial.summary ||
    fields.text !== initial.text;

  const submit = async () => {
    if (!complete || !changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(fields);
    } catch (cause) {
      setError(noteActionErrorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>Title</span>
        <Input
          value={title}
          maxLength={PROJECT_NOTE_TITLE_MAX_CHARS}
          readOnly={saving}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="Test database"
          aria-label="Note title"
          autoFocus={initial === null}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>One line</span>
        <Input
          value={summary}
          maxLength={PROJECT_NOTE_SUMMARY_MAX_CHARS}
          readOnly={saving}
          onChange={(event) => setSummary(event.currentTarget.value)}
          placeholder="What the note is about, for the list every thread gets"
          aria-label="Note one line"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>Text</span>
        <Textarea
          value={text}
          maxLength={PROJECT_NOTE_TEXT_MAX_CHARS}
          readOnly={saving}
          rows={5}
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder="What a later thread should know"
          aria-label="Note text"
          className="text-[13px]"
        />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-[18px] text-muted-foreground">{hint}</p>
        <div className="flex items-center gap-1.5">
          {extraAction}
          <Button size="xs" variant="outline" type="button" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="xs" type="submit" disabled={!complete || !changed || saving}>
            {saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            {submitLabel}
          </Button>
        </div>
      </div>
      <RowError text={error} />
    </form>
  );
}
