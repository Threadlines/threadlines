/**
 * The narrowings the pull requests page offers, and the order it lists what is
 * left in. Everything here reads the rows the page already loaded, so a filter
 * never costs a read, and it all lives in the URL, so a link keeps it.
 */
import { SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SECTION_LABEL_CLASS, TEXT_BUTTON_CLASS, TextChoice } from "./pullRequestPresentation";
import {
  PULL_REQUEST_SORT_LABELS,
  pullRequestFilterChips,
  type PullRequestChecksFilter,
  type PullRequestDraftFilter,
  type PullRequestFilters,
  type PullRequestReviewFilter,
  type PullRequestSort,
} from "./pullRequests.logic";

const DRAFT_OPTIONS: readonly { value: PullRequestDraftFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "only", label: "Only drafts" },
  { value: "hide", label: "No drafts" },
];

const REVIEW_OPTIONS: readonly { value: PullRequestReviewFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "approved", label: "Approved" },
  { value: "changes-requested", label: "Changes requested" },
  { value: "review-required", label: "Review required" },
];

const CHECKS_OPTIONS: readonly { value: PullRequestChecksFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "passing", label: "Passing" },
  { value: "failing", label: "Failing" },
];

const SORT_OPTIONS: readonly { value: PullRequestSort; label: string }[] = (
  ["updated", "created", "size"] as const
).map((value) => ({ value, label: PULL_REQUEST_SORT_LABELS[value] }));

/** The control beside the search, and everything it opens. */
export function PullRequestFiltersButton({
  filters,
  sort,
  viewer,
  onFiltersChange,
  onSortChange,
}: {
  readonly filters: PullRequestFilters;
  readonly sort: PullRequestSort;
  /** The signed-in login, offered as a quick pick for the author field. */
  readonly viewer: string | null;
  readonly onFiltersChange: (filters: PullRequestFilters) => void;
  readonly onSortChange: (sort: PullRequestSort) => void;
}) {
  const activeCount = pullRequestFilterChips(filters).length;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7.5 shrink-0 sm:h-6.5"
            data-testid="pull-requests-filters"
          />
        }
      >
        <SlidersHorizontalIcon />
        {/* The count shares the word's baseline: centred in the button it
            would sit above the word's baseline as though it were floating. */}
        <span className="inline-flex items-baseline gap-1.5">
          Filters
          {activeCount > 0 ? (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {activeCount}
            </span>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[21rem]">
        <FilterField label="Author">
          <FilterText
            label="Author"
            value={filters.author}
            placeholder="A login"
            {...(viewer === null ? {} : { quickPick: viewer })}
            onChange={(author) => onFiltersChange({ ...filters, author })}
          />
        </FilterField>

        <FilterField label="Labels">
          <FilterText
            label="Labels to include"
            value={filters.labels}
            placeholder="bug, ux"
            onChange={(labels) => onFiltersChange({ ...filters, labels })}
          />
        </FilterField>

        <FilterField label="Excluded labels">
          <FilterText
            label="Labels to exclude"
            value={filters.excludeLabels}
            placeholder="wip, stale"
            onChange={(excludeLabels) => onFiltersChange({ ...filters, excludeLabels })}
          />
        </FilterField>

        <FilterField label="Draft">
          <FilterChoice
            label="Draft"
            value={filters.draft}
            options={DRAFT_OPTIONS}
            onChange={(draft) => onFiltersChange({ ...filters, draft })}
          />
        </FilterField>

        <FilterField label="Review">
          <FilterChoice
            label="Review"
            value={filters.review}
            options={REVIEW_OPTIONS}
            onChange={(review) => onFiltersChange({ ...filters, review })}
          />
        </FilterField>

        <FilterField label="Checks">
          <FilterChoice
            label="Checks"
            value={filters.checks}
            options={CHECKS_OPTIONS}
            onChange={(checks) => onFiltersChange({ ...filters, checks })}
          />
        </FilterField>

        <FilterField label="Sort">
          <FilterChoice label="Sort" value={sort} options={SORT_OPTIONS} onChange={onSortChange} />
        </FilterField>
      </PopoverPopup>
    </Popover>
  );
}

/** Every narrowing in force, each one a word and the way to lift it. */
export function PullRequestFilterChipsRow({
  filters,
  onFiltersChange,
}: {
  readonly filters: PullRequestFilters;
  readonly onFiltersChange: (filters: PullRequestFilters) => void;
}) {
  const chips = pullRequestFilterChips(filters);
  if (chips.length === 0) {
    return null;
  }

  return (
    <div
      className="mt-2 flex min-w-0 flex-wrap items-center gap-y-1 text-xs text-muted-foreground/70"
      data-testid="pull-requests-filter-chips"
    >
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="flex min-w-0 items-center gap-1 border-l border-border/50 pl-2 pr-2 first:border-l-0 first:pl-0"
        >
          <span className="min-w-0 truncate">{chip.label}</span>
          {/* A 12px glyph is not a thumb-sized target, so a coarse pointer gets
              padding around it rather than a bigger ✕. */}
          <button
            type="button"
            className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/55 transition-colors hover:text-foreground focus-ring pointer-coarse:p-2"
            aria-label={`Remove filter ${chip.label}`}
            onClick={() => onFiltersChange(chip.next)}
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="mt-4 first:mt-0">
      <h3 className={SECTION_LABEL_CLASS}>{label}</h3>
      {children}
    </section>
  );
}

/**
 * A typed field that answers to the keyboard before the route does. The route
 * owns the value, but its round trip is a navigation, and a field waiting for
 * one would drop characters; the field is read from the route when the popover
 * opens and written to it from there on, which is the only direction it moves
 * while it is on screen.
 */
function FilterText({
  label,
  value,
  placeholder,
  quickPick,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  /** A value worth one press, such as the signed-in login. */
  readonly quickPick?: string;
  readonly onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const update = (next: string) => {
    setDraft(next);
    onChange(next);
  };

  return (
    <>
      <Input
        size="sm"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        onChange={(event) => update(event.target.value)}
      />
      {quickPick !== undefined && quickPick.toLowerCase() !== draft.trim().toLowerCase() ? (
        <button
          type="button"
          className={cn(TEXT_BUTTON_CLASS, "mt-1.5 text-xs")}
          onClick={() => update(quickPick)}
        >
          Use {quickPick}
        </button>
      ) : null}
    </>
  );
}

/** One choice out of a few, wrapping onto a second line where it must. */
function FilterChoice<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly { value: Value; label: string }[];
  readonly onChange: (value: Value) => void;
}) {
  return <TextChoice label={label} value={value} options={options} onChange={onChange} />;
}
