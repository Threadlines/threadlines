/**
 * What a sign-in asks the user, answered where it is shown: a list to pick
 * from (which provider to connect; searchable when long, in the agent's
 * groups), or a field for a key or a code (a password field for a key).
 *
 * The question's wording is the panel's status line, so the form draws only
 * the answer. Settings and the setup screen show it; the composer has no room
 * and hands the run to Settings instead.
 *
 * @module ProviderAuthQuestionForm
 */
import type { ProviderAuthQuestionOption } from "@threadlines/contracts";
import { LoaderIcon, SearchIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import type { ProviderConnectFlowState } from "./providerConnectFlow.logic";

type Question = NonNullable<ProviderConnectFlowState["question"]>;

/** Past this many options the list gets a search field. */
const SEARCHABLE_OPTIONS = 8;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "That didn't work. Try again.";
}

/** Options under their group names, in the order the agent gave them. */
function groupOptions(options: ReadonlyArray<ProviderAuthQuestionOption>): ReadonlyArray<{
  readonly group: string | null;
  readonly options: ProviderAuthQuestionOption[];
}> {
  const groups: Array<{ group: string | null; options: ProviderAuthQuestionOption[] }> = [];
  for (const option of options) {
    const group = option.group ?? null;
    const last = groups.at(-1);
    if (last && last.group === group) last.options.push(option);
    else groups.push({ group, options: [option] });
  }
  return groups;
}

function matches(option: ProviderAuthQuestionOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [option.label, option.detail ?? "", option.group ?? ""].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

function ChoiceQuestion(props: {
  readonly question: Question;
  readonly onAnswer: (value: string | null) => Promise<void>;
}) {
  const { options } = props.question;
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchable = options.length > SEARCHABLE_OPTIONS;
  const shown = useMemo(() => options.filter((option) => matches(option, query)), [options, query]);
  const groups = useMemo(() => groupOptions(shown), [shown]);

  const pick = (id: string) => {
    if (pendingId !== null) return;
    setPendingId(id);
    setError(null);
    props.onAnswer(id).catch((cause: unknown) => {
      setPendingId(null);
      setError(errorText(cause));
    });
  };

  const rows = (
    <div role="listbox" aria-label={props.question.message} className="py-1">
      {groups.map(({ group, options: grouped }) => (
        <div key={group ?? ""} role="group" aria-label={group ?? undefined}>
          {group ? <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">{group}</p> : null}
          {grouped.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={pendingId === option.id}
              disabled={pendingId !== null}
              onClick={() => pick(option.id)}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span className="min-w-0 flex-1 truncate">
                {option.label}
                {option.detail ? (
                  <span className="ms-1.5 text-muted-foreground">{option.detail}</span>
                ) : null}
              </span>
              {pendingId === option.id ? (
                <LoaderIcon className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : option.configured ? (
                <span className="shrink-0 text-xs text-success">Connected</span>
              ) : null}
            </button>
          ))}
        </div>
      ))}
      {shown.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Nothing matches "{query}".</p>
      ) : null}
    </div>
  );

  return (
    <div className="grid gap-1.5" data-agent-row-toggle-ignore>
      <div className="overflow-hidden rounded-md border border-group-divider">
        {searchable ? (
          <div className="flex items-center gap-2 border-b border-group-divider px-3">
            <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the list was just asked for
              autoFocus
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && shown.length > 0) {
                  event.preventDefault();
                  pick(shown[0]!.id);
                } else if (event.key === "Escape" && query.length > 0) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Search"
              aria-label="Search the choices"
              className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            {query.length > 0 ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ) : null}
        {searchable ? (
          <ScrollArea scrollFade observeContentResize className="h-[min(21rem,55vh)]">
            {rows}
          </ScrollArea>
        ) : (
          rows
        )}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function TextQuestion(props: {
  readonly question: Question;
  readonly onAnswer: (value: string | null) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secret = props.question.kind === "secret";
  return (
    <form
      className="grid gap-1.5"
      data-agent-row-toggle-ignore
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        // Read from the field itself: Enter can come before the next render.
        const form = event.currentTarget;
        const typed = String(new FormData(form).get("answer") ?? "");
        // A key is never blank; other answers can be (an empty domain means the default).
        if (secret && typed.trim().length === 0) return;
        setPending(true);
        setError(null);
        props
          .onAnswer(secret ? typed.trim() : typed)
          .then(() => form.reset())
          .catch((cause: unknown) => setError(errorText(cause)))
          .finally(() => setPending(false));
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          size="sm"
          nativeInput
          name="answer"
          type={secret ? "password" : "text"}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field was just asked for
          autoFocus
          autoComplete="off"
          spellCheck={false}
          // Not left to the browser's implicit submit, which some keyboards never trigger.
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          placeholder={props.question.placeholder ?? (secret ? "Paste the key" : undefined)}
          aria-label={props.question.message}
          className={cn("min-w-0 flex-1", !secret && "font-mono text-[12px]")}
        />
        <Button
          type="submit"
          size="xs"
          className="h-6 shrink-0 gap-1 px-2 text-xs"
          disabled={pending}
        >
          {pending ? <LoaderIcon className="size-2.5 animate-spin" /> : null}
          Continue
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}

export function ProviderAuthQuestionForm(props: {
  readonly question: Question;
  /** The chosen option's id or the typed text; rejects with the server's reason. */
  readonly onAnswer: (value: string | null) => Promise<void>;
}) {
  // Keyed by the question, so a new one starts with an empty field.
  return props.question.kind === "choice" ? (
    <ChoiceQuestion key={props.question.requestId} {...props} />
  ) : (
    <TextQuestion key={props.question.requestId} {...props} />
  );
}
