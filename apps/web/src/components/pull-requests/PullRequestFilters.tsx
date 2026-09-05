/**
 * The narrowings the pull requests page offers, and the order it lists what is
 * left in. Everything here reads the rows the page already loaded, so a filter
 * never costs a read, and it all lives in the URL, so a link keeps it.
 */
import { ArrowUpDownIcon, ChevronDownIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLoadedPullRequestEntries } from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  MENU_PICK_ITEM_CLASS_NAME,
  MENU_PICK_ITEM_SELECTED_CLASS_NAME,
} from "../ui/menu";
import { PullRequestActorAvatar } from "./pullRequestPresentation";
import {
  hasPullRequestLabel,
  PULL_REQUEST_INVOLVEMENT_WORDS,
  PULL_REQUEST_SORT_LABELS,
  pullRequestAuthorFacets,
  pullRequestFilterChips,
  pullRequestLabelColor,
  pullRequestLabelFacets,
  pullRequestProjectFacets,
  togglePullRequestLabel,
  type PullRequestChecksFilter,
  type PullRequestDraftFilter,
  type PullRequestFilters,
  type PullRequestInvolvementFilter,
  type PullRequestReviewFilter,
  type PullRequestSort,
} from "./pullRequests.logic";

/** A menu is not a place to scroll through a hundred logins. */
const MAX_AUTHOR_CHOICES = 10;

interface FilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

const INVOLVEMENT_OPTIONS: readonly FilterOption<PullRequestInvolvementFilter>[] = (
  ["all", "needs-you", "yours", "others"] as const
).map((value) => ({ value, label: PULL_REQUEST_INVOLVEMENT_WORDS[value] }));

const DRAFT_OPTIONS: readonly FilterOption<PullRequestDraftFilter>[] = [
  { value: "any", label: "Any" },
  { value: "only", label: "Only drafts" },
  { value: "hide", label: "No drafts" },
];

const REVIEW_OPTIONS: readonly FilterOption<PullRequestReviewFilter>[] = [
  { value: "any", label: "Any" },
  { value: "approved", label: "Approved" },
  { value: "changes-requested", label: "Changes requested" },
  { value: "review-required", label: "Review required" },
  { value: "none", label: "No reviews" },
];

const CHECKS_OPTIONS: readonly FilterOption<PullRequestChecksFilter>[] = [
  { value: "any", label: "Any" },
  { value: "passing", label: "Passing" },
  { value: "failing", label: "Failing" },
  { value: "running", label: "Running" },
];

const SORT_OPTIONS: readonly FilterOption<PullRequestSort>[] = (
  ["readiness", "updated", "newest", "oldest", "largest", "smallest"] as const
).map((value) => ({ value, label: PULL_REQUEST_SORT_LABELS[value] }));

/** The order the list is read in, as one menu of plain choices. */
export function PullRequestSortMenu({
  sort,
  onSortChange,
}: {
  readonly sort: PullRequestSort;
  readonly onSortChange: (sort: PullRequestSort) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7.5 shrink-0 sm:h-6.5"
            data-testid="pull-requests-sort"
          />
        }
      >
        <ArrowUpDownIcon />
        Sort
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-56">
        <MenuRadioGroup
          value={sort}
          onValueChange={(value) => onSortChange(value as PullRequestSort)}
        >
          {SORT_OPTIONS.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** Every narrowing the list offers, one line each, the current value alongside. */
export function PullRequestFiltersButton({
  filters,
  onFiltersChange,
}: {
  readonly filters: PullRequestFilters;
  readonly onFiltersChange: (filters: PullRequestFilters) => void;
}) {
  const activeCount = pullRequestFilterChips(filters).length;

  return (
    <Menu>
      <MenuTrigger
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
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-56">
        <PullRequestFiltersMenuContent filters={filters} onFiltersChange={onFiltersChange} />
      </MenuPopup>
    </Menu>
  );
}

/**
 * The menu's lines. Its own component because the popup only mounts while it
 * is open: the author, label and project choices are read from every listing
 * the page holds, and there is no reason to gather them until they are asked
 * for.
 */
function PullRequestFiltersMenuContent({
  filters,
  onFiltersChange,
}: {
  readonly filters: PullRequestFilters;
  readonly onFiltersChange: (filters: PullRequestFilters) => void;
}) {
  const entries = useLoadedPullRequestEntries();
  const authors = useMemo(() => pullRequestAuthorFacets(entries), [entries]);
  const labels = useMemo(() => pullRequestLabelFacets(entries), [entries]);
  const projects = useMemo(() => pullRequestProjectFacets(entries), [entries]);

  return (
    <>
      <FilterRadioSubmenu
        label="Involvement"
        value={filters.involvement}
        options={INVOLVEMENT_OPTIONS}
        onChange={(involvement) => onFiltersChange({ ...filters, involvement })}
      />

      <MenuSeparator />

      <AuthorSubmenu
        authors={authors}
        value={filters.author}
        onChange={(author) => onFiltersChange({ ...filters, author })}
      />
      <LabelsSubmenu
        labels={labels}
        value={filters.labels}
        onChange={(nextLabels) => onFiltersChange({ ...filters, labels: nextLabels })}
      />
      <FilterRadioSubmenu
        label="Draft"
        value={filters.draft}
        options={DRAFT_OPTIONS}
        onChange={(draft) => onFiltersChange({ ...filters, draft })}
      />
      <FilterRadioSubmenu
        label="Review"
        value={filters.review}
        options={REVIEW_OPTIONS}
        onChange={(review) => onFiltersChange({ ...filters, review })}
      />
      <FilterRadioSubmenu
        label="Checks"
        value={filters.checks}
        options={CHECKS_OPTIONS}
        onChange={(checks) => onFiltersChange({ ...filters, checks })}
      />

      <MenuSeparator />

      <FilterSubmenu label="Project" value={projectValueLabel(projects, filters.project)}>
        {/* One project at a time, so the menu says as much: a reader hears
            which one is current instead of a fill they cannot see. */}
        <MenuRadioGroup
          value={filters.project}
          onValueChange={(project) => onFiltersChange({ ...filters, project: String(project) })}
        >
          <MenuRadioItem value="">All projects</MenuRadioItem>
          {projects.map((project) => (
            <MenuRadioItem key={project.key} value={project.key}>
              <span className="min-w-0 truncate">{project.label}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </FilterSubmenu>
    </>
  );
}

/** One line of the menu: what it narrows, what it is narrowed to, and the choices. */
function FilterSubmenu({
  label,
  value,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly children: ReactNode;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <span className="min-w-0 flex-1">{label}</span>
        <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70">{value}</span>
      </MenuSubTrigger>
      <MenuSubPopup className="w-56">{children}</MenuSubPopup>
    </MenuSub>
  );
}

/** A submenu of one choice out of a few. */
function FilterRadioSubmenu<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly FilterOption<Value>[];
  readonly onChange: (value: Value) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <FilterSubmenu label={label} value={current?.label ?? ""}>
      <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
        {options.map((option) => (
          <MenuRadioItem key={option.value} value={option.value}>
            {option.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </FilterSubmenu>
  );
}

/** The logins the loaded rows carry, the chosen one first, searchable. */
function AuthorSubmenu({
  authors,
  value,
  onChange,
}: {
  readonly authors: readonly { login: string; avatarUrl: string | null }[];
  readonly value: string;
  readonly onChange: (author: string) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = value.trim().toLowerCase();
  const matching = authors
    .filter((author) => author.login.toLowerCase().includes(search.trim().toLowerCase()))
    .toSorted(
      (left, right) =>
        Number(right.login.toLowerCase() === selected) -
        Number(left.login.toLowerCase() === selected),
    )
    .slice(0, MAX_AUTHOR_CHOICES);

  return (
    <FilterSubmenu label="Author" value={value.trim() === "" ? "Anyone" : value.trim()}>
      <FilterSearchInput label="Search authors" value={search} onChange={setSearch} />
      {/* Logins are compared folded, so the radio's values are folded too and
          the login the row spells is what the filter is written with. */}
      <MenuRadioGroup
        value={selected}
        onValueChange={(next) =>
          onChange(
            matching.find((author) => author.login.toLowerCase() === next)?.login ?? String(next),
          )
        }
      >
        <MenuRadioItem value="">Anyone</MenuRadioItem>
        {matching.map((author) => (
          <MenuRadioItem key={author.login} value={author.login.toLowerCase()}>
            <PullRequestActorAvatar
              actor={{ login: author.login, isBot: false, avatarUrl: author.avatarUrl }}
            />
            <span className="min-w-0 truncate">{author.login}</span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </FilterSubmenu>
  );
}

/** The labels the loaded rows carry, as many as the user wants at once. */
function LabelsSubmenu({
  labels,
  value,
  onChange,
}: {
  readonly labels: readonly { name: string; color: string | null }[];
  readonly value: string;
  readonly onChange: (labels: string) => void;
}) {
  const [search, setSearch] = useState("");
  const matching = labels.filter((label) =>
    label.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <FilterSubmenu label="Labels" value={value.trim() === "" ? "Any" : value.trim()}>
      <FilterSearchInput label="Search labels" value={search} onChange={setSearch} />
      <MenuItem
        className={cn(
          MENU_PICK_ITEM_CLASS_NAME,
          value.trim() === "" && MENU_PICK_ITEM_SELECTED_CLASS_NAME,
        )}
        onClick={() => onChange("")}
      >
        Any
      </MenuItem>
      {matching.map((label) => {
        const dot = pullRequestLabelColor(label.color);
        return (
          <MenuCheckboxItem
            key={label.name}
            checked={hasPullRequestLabel(value, label.name)}
            closeOnClick={false}
            onCheckedChange={() => onChange(togglePullRequestLabel(value, label.name))}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-muted-foreground"
                {...(dot ? { style: { backgroundColor: dot } } : {})}
              />
              <span className="min-w-0 truncate">{label.name}</span>
            </span>
          </MenuCheckboxItem>
        );
      })}
    </FilterSubmenu>
  );
}

/** The field at the top of a long submenu, filtering the lines below it. */
function FilterSearchInput({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  // The submenu mounts this when it opens and moves focus into itself as it
  // does, so the field takes the cursor on the frame after that move: typing
  // is what the field is for, and the list below it is one arrow key away.
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="p-1">
      <Input
        ref={input}
        size="sm"
        value={value}
        aria-label={label}
        placeholder="Search"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        // A menu treats letters as a jump to the item that starts with them,
        // and the caret keys as a walk along its own rows, both of which would
        // take the field's typing away from it. Up and Down still walk the
        // list, and Escape, Enter and Tab still steer the menu.
        onKeyDown={(event) => {
          if (event.key.length === 1 || CARET_KEYS.has(event.key)) {
            event.stopPropagation();
          }
        }}
      />
    </div>
  );
}

/** What a caret does inside a field, rather than what it does to a menu. */
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** What the Project line reads as, the key standing in until the rows name it. */
function projectValueLabel(
  projects: readonly { key: string; label: string }[],
  value: string,
): string {
  if (value.trim() === "") {
    return "All projects";
  }
  return projects.find((project) => project.key === value)?.label ?? value;
}

/** Every narrowing in force, each one a word and the way to lift it. */
export function PullRequestFilterChipsRow({
  filters,
  projectLabel,
  onFiltersChange,
}: {
  readonly filters: PullRequestFilters;
  /** What the chosen project is called, which only the loaded rows know. */
  readonly projectLabel?: string;
  readonly onFiltersChange: (filters: PullRequestFilters) => void;
}) {
  const chips = pullRequestFilterChips(filters, projectLabel);
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
