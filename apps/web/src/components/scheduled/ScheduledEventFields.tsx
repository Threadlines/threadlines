import type { GitHubEventPreset, ScheduledTaskGitHubContext } from "@threadlines/contracts";
import { GITHUB_WEBHOOK_EVENTS } from "@threadlines/shared/webhookTasks";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { SETTINGS_GROUP_ROW_CLASS } from "../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import {
  DropdownChevron,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import {
  anyoneConfirmText,
  formatLateLimit,
  GITHUB_PRESET_LABELS,
  GITHUB_PRESETS,
  GITHUB_STYLE_SIGNATURE,
  githubEventFields,
  githubEventLabel,
  lateLimitOptions,
  MAX_WEBHOOK_FILTER_ROWS,
  WEBHOOK_FILTER_OP_LABELS,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterRow,
  type WebhookForm,
  webhookFormEvents,
} from "./scheduled.logic";
import { FieldRow } from "./ScheduledFormRow";

/** A GitHub username as typed: no "@", no spaces. */
const loginOf = (text: string) => text.trim().replace(/^@+/u, "");

/** "Only from": the GitHub users whose events start a run, as removable chips and a field to add one. */
function PeopleField({
  logins,
  onChange,
}: {
  readonly logins: readonly string[];
  readonly onChange: (logins: readonly string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const login = loginOf(draft);
    if (login.length === 0) return;
    if (!logins.some((existing) => existing.toLowerCase() === login.toLowerCase())) {
      onChange([...logins, login]);
    }
    setDraft("");
  };
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
      {logins.map((login) => (
        <Badge
          key={login}
          variant="secondary"
          size="lg"
          className="gap-0.5 ps-2 pe-0.5 font-normal"
          data-testid={`scheduled-event-person-${login}`}
        >
          @{login}
          <button
            type="button"
            className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-ring"
            aria-label={`Remove @${login}`}
            onClick={() => onChange(logins.filter((entry) => entry !== login))}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <Input
        size="sm"
        className="w-full min-w-0 sm:w-48"
        value={draft}
        placeholder="Add a GitHub username"
        aria-label="Add a GitHub username"
        data-testid="scheduled-event-add-person"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "," || event.key === " ") {
            event.preventDefault();
            add();
          } else if (event.key === "Backspace" && draft.length === 0 && logins.length > 0) {
            onChange(logins.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

/** One filter: the field it reads, the test, and the value (none for "exists"). */
function FilterRowFields({
  row,
  index,
  pathHint,
  onChange,
  onRemove,
}: {
  readonly row: WebhookFilterRow;
  readonly index: number;
  /** An example field for the source, as the path's placeholder. */
  readonly pathHint: string;
  readonly onChange: (row: WebhookFilterRow) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div
      className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:flex-nowrap"
      data-testid={`scheduled-event-filter-${index}`}
    >
      <Input
        size="sm"
        className="w-full min-w-0 font-mono sm:flex-1"
        value={row.path}
        placeholder={pathHint}
        aria-label={`Filter ${index + 1} field`}
        onChange={(event) => onChange({ ...row, path: event.target.value })}
      />
      <Select
        value={row.op}
        onValueChange={(value) => {
          if (value) onChange({ ...row, op: value });
        }}
      >
        <SelectTrigger size="sm" className="w-28 shrink-0" aria-label={`Filter ${index + 1} test`}>
          <SelectValue>{WEBHOOK_FILTER_OP_LABELS[row.op]}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {WEBHOOK_FILTER_OPS.map((op) => (
            <SelectItem key={op} value={op}>
              {WEBHOOK_FILTER_OP_LABELS[op]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {row.op === "exists" ? null : (
        <Input
          size="sm"
          className="min-w-0 flex-1"
          value={row.value}
          placeholder={row.op === "in" ? "bug, agent" : "agent"}
          aria-label={`Filter ${index + 1} value`}
          onChange={(event) => onChange({ ...row, value: event.target.value })}
        />
      )}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Remove filter ${index + 1}`}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** The collapsed "More" row's line: what's set inside, so a closed section still says it. */
function moreSummary(webhook: WebhookForm): string {
  const filters =
    webhook.filters.length === 0
      ? "No filters"
      : `${webhook.filters.length} filter${webhook.filters.length === 1 ? "" : "s"}`;
  return `${filters} · skips events ${formatLateLimit(webhook.maxLateMinutes)} late · ${webhook.dailyRunLimit} runs a day`;
}

/**
 * The Schedule section's rows for "When something happens"
 * (docs/design/event-tasks.md, UI): where events come from, what on GitHub
 * starts a run and whose events count, or an outside service's signature;
 * then, folded under More, filters, the late and daily limits, and whether
 * the event goes into the message. `webhook` is the form's start as it
 * stands (the project's repository and the user's login filled in).
 */
export function ScheduledEventFields({
  webhook,
  onChange,
  context,
  problem,
}: {
  readonly webhook: WebhookForm;
  readonly onChange: (patch: Partial<WebhookForm>) => void;
  readonly context: ScheduledTaskGitHubContext | null;
  readonly problem: string | undefined;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmAnyone, setConfirmAnyone] = useState(false);
  const repository = webhook.repository.trim();
  const labelPreset = webhook.when === "issue_labeled" || webhook.when === "pr_labeled";
  const insertableFields =
    webhook.source === "github" ? githubEventFields(webhookFormEvents(webhook)) : [];
  const canAddFilter = webhook.filters.length < MAX_WEBHOOK_FILTER_ROWS;
  const addFilter = (path: string) =>
    onChange({ filters: [...webhook.filters, { path, op: "equals", value: "" }] });
  const setFilter = (index: number, row: WebhookFilterRow) =>
    onChange({ filters: webhook.filters.map((entry, at) => (at === index ? row : entry)) });

  return (
    <>
      <FieldRow label="Where" hint="Where the events come from.">
        <SegmentedControl
          value={webhook.source}
          onValueChange={(source) => onChange({ source, sourceChosen: true })}
          aria-label="Where"
        >
          <SegmentedControlItem value="github" data-testid="scheduled-event-source-github">
            GitHub
          </SegmentedControlItem>
          <SegmentedControlItem value="any" data-testid="scheduled-event-source-any">
            Any service
          </SegmentedControlItem>
        </SegmentedControl>
      </FieldRow>

      {webhook.source === "github" ? (
        <>
          <FieldRow
            label="Repository"
            hint={
              !webhook.repositoryChosen && context?.repository
                ? "From the project's origin remote."
                : "owner/name on GitHub."
            }
          >
            <Input
              size="sm"
              className="w-full font-mono sm:w-52"
              value={webhook.repository}
              placeholder="acme/app"
              aria-label="Repository"
              data-testid="scheduled-event-repository"
              onChange={(event) =>
                onChange({ repository: event.target.value, repositoryChosen: true })
              }
            />
          </FieldRow>
          <FieldRow label="When">
            <Select
              value={webhook.when}
              onValueChange={(value) => {
                if (value) onChange({ when: value as GitHubEventPreset });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-56"
                aria-label="When"
                data-testid="scheduled-event-when"
              >
                <SelectValue>{GITHUB_PRESET_LABELS[webhook.when]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {GITHUB_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {GITHUB_PRESET_LABELS[preset]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {labelPreset ? (
              <Input
                size="sm"
                className="w-full sm:w-36"
                value={webhook.label}
                placeholder="agent"
                aria-label="Label"
                data-testid="scheduled-event-label"
                onChange={(event) => onChange({ label: event.target.value })}
              />
            ) : null}
            {webhook.when === "comment_phrase" ? (
              <Input
                size="sm"
                className="w-full sm:w-44"
                value={webhook.phrase}
                placeholder="@agent please"
                aria-label="Words"
                data-testid="scheduled-event-phrase"
                onChange={(event) => onChange({ phrase: event.target.value })}
              />
            ) : null}
          </FieldRow>
          {webhook.when === "custom" ? (
            <FieldRow
              label="Events"
              hint="The GitHub events to send. Filters below narrow them down."
              stacked
            >
              <div className="grid w-full grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {GITHUB_WEBHOOK_EVENTS.map((event) => (
                  <label
                    key={event}
                    className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-foreground"
                  >
                    <Checkbox
                      checked={webhook.events.includes(event)}
                      onCheckedChange={(checked) =>
                        onChange({
                          events: checked
                            ? [...webhook.events, event]
                            : webhook.events.filter((entry) => entry !== event),
                        })
                      }
                    />
                    <span className="truncate">{githubEventLabel(event)}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {event}
                    </span>
                  </label>
                ))}
              </div>
            </FieldRow>
          ) : null}
          <FieldRow
            label="Only from"
            hint={
              webhook.anyone
                ? anyoneConfirmText(repository)
                : "Events anyone else starts are skipped."
            }
          >
            <SegmentedControl
              value={webhook.anyone ? "anyone" : "people"}
              onValueChange={(value) => {
                if (value === "people") onChange({ anyone: false });
                else setConfirmAnyone(true);
              }}
              aria-label="Only from"
            >
              <SegmentedControlItem value="people">These people</SegmentedControlItem>
              <SegmentedControlItem value="anyone" data-testid="scheduled-event-anyone">
                Anyone
              </SegmentedControlItem>
            </SegmentedControl>
          </FieldRow>
          {webhook.anyone ? null : (
            <FieldRow label="People" stacked testId="scheduled-event-people">
              <PeopleField
                logins={webhook.logins}
                onChange={(logins) => onChange({ logins, loginsChosen: true })}
              />
            </FieldRow>
          )}
          <FieldRow label="Ignore bots" hint="Events a bot account starts are skipped.">
            <Switch
              checked={webhook.ignoreBots}
              aria-label="Ignore bots"
              onCheckedChange={(checked) => onChange({ ignoreBots: Boolean(checked) })}
            />
          </FieldRow>
        </>
      ) : (
        <>
          <FieldRow
            label="Signature"
            hint={
              webhook.signed
                ? "Each event must be signed with the task's secret. Set or generate it on the task's page once it's saved."
                : "Recommended. Without one, anyone who has the address can start a run."
            }
          >
            <Switch
              checked={webhook.signed}
              aria-label="Check a signature"
              data-testid="scheduled-event-signed"
              onCheckedChange={(checked) => onChange({ signed: Boolean(checked) })}
            />
          </FieldRow>
          {webhook.signed ? (
            <>
              <FieldRow label="Header" hint="The header the signature comes in.">
                <Input
                  size="sm"
                  className="w-full font-mono sm:w-52"
                  value={webhook.signature.header}
                  placeholder="X-Signature"
                  aria-label="Signature header"
                  onChange={(event) =>
                    onChange({ signature: { ...webhook.signature, header: event.target.value } })
                  }
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange({ signature: GITHUB_STYLE_SIGNATURE })}
                >
                  GitHub style
                </Button>
              </FieldRow>
              <FieldRow label="Encoding" hint="How the HMAC-SHA256 of the body is written.">
                <SegmentedControl
                  value={webhook.signature.encoding}
                  onValueChange={(encoding) =>
                    onChange({ signature: { ...webhook.signature, encoding } })
                  }
                  aria-label="Encoding"
                >
                  <SegmentedControlItem value="hex">Hex</SegmentedControlItem>
                  <SegmentedControlItem value="base64">Base64</SegmentedControlItem>
                </SegmentedControl>
              </FieldRow>
              <FieldRow label="Prefix" hint="Text before the signature, if any.">
                <Input
                  size="sm"
                  className="w-full font-mono sm:w-32"
                  value={webhook.signature.prefix}
                  placeholder="sha256="
                  aria-label="Signature prefix"
                  onChange={(event) =>
                    onChange({ signature: { ...webhook.signature, prefix: event.target.value } })
                  }
                />
              </FieldRow>
            </>
          ) : null}
        </>
      )}

      <div className={SETTINGS_GROUP_ROW_CLASS}>
        <button
          type="button"
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-3.5 py-2.5 text-left focus-ring"
          aria-expanded={moreOpen}
          data-testid="scheduled-event-more"
          onClick={() => setMoreOpen((open) => !open)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              moreOpen && "rotate-90",
            )}
          />
          <span className="text-[13.5px] leading-[19px] font-medium text-foreground">More</span>
          {moreOpen ? null : (
            <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
              {moreSummary(webhook)}
            </span>
          )}
        </button>
      </div>
      {moreOpen ? (
        <>
          <FieldRow
            label="Filters"
            hint={
              <>
                Events must pass every filter. A field reads the body (issue.title),{" "}
                <span className="font-mono">headers.name</span> or{" "}
                <span className="font-mono">query.name</span>; <span className="font-mono">[]</span>{" "}
                reads each item of a list.
              </>
            }
            stacked
            testId="scheduled-event-filters"
          >
            {webhook.filters.map((row, index) => (
              <FilterRowFields
                // oxlint-disable-next-line react/no-array-index-key -- controlled rows: a row's place is its identity
                key={index}
                row={row}
                index={index}
                pathHint={
                  webhook.source === "github" ? "issue.labels[].name" : "headers.x-event-type"
                }
                onChange={(next) => setFilter(index, next)}
                onRemove={() =>
                  onChange({ filters: webhook.filters.filter((_, at) => at !== index) })
                }
              />
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canAddFilter}
                onClick={() => addFilter("")}
              >
                Add filter
              </Button>
              {insertableFields.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    disabled={!canAddFilter}
                    render={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="scheduled-event-insert-field"
                      />
                    }
                  >
                    Insert field
                    <DropdownChevron solid />
                  </MenuTrigger>
                  <MenuPopup align="start" className="max-h-72">
                    {insertableFields.map((field) => (
                      <MenuItem
                        key={field}
                        className="font-mono text-xs"
                        onClick={() => addFilter(field)}
                      >
                        {field}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          </FieldRow>
          <FieldRow label="Late events" hint="Skip events that arrive more than this late.">
            <Select
              value={String(webhook.maxLateMinutes)}
              onValueChange={(value) => {
                if (value !== null) onChange({ maxLateMinutes: Number(value) });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="Late events">
                <SelectValue>{formatLateLimit(webhook.maxLateMinutes)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {lateLimitOptions(webhook.maxLateMinutes).map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {formatLateLimit(minutes)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </FieldRow>
          <FieldRow label="Runs a day" hint="At most this many runs a day, from 1 to 200.">
            <Input
              size="sm"
              className="w-20"
              type="number"
              inputMode="numeric"
              min={1}
              max={200}
              step={1}
              value={String(webhook.dailyRunLimit)}
              aria-label="Runs a day"
              onChange={(event) =>
                onChange({ dailyRunLimit: Number.parseInt(event.target.value, 10) || 0 })
              }
            />
          </FieldRow>
          <FieldRow
            label="Add the event to the message"
            hint={
              webhook.source === "github"
                ? "The run's message ends with what happened on GitHub."
                : "The run's message ends with the event's JSON."
            }
          >
            <Switch
              checked={webhook.includeEvent}
              aria-label="Add the event to the message"
              onCheckedChange={(checked) => onChange({ includeEvent: Boolean(checked) })}
            />
          </FieldRow>
        </>
      ) : null}

      {problem ? (
        <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}>
          <p
            className="text-[12px] text-destructive-foreground"
            data-testid="scheduled-event-problem"
          >
            {problem}
          </p>
        </div>
      ) : null}

      <AlertDialog open={confirmAnyone} onOpenChange={setConfirmAnyone}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Take events from anyone?</AlertDialogTitle>
            <AlertDialogDescription>{anyoneConfirmText(repository)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              data-testid="scheduled-event-anyone-confirm"
              onClick={() => {
                onChange({ anyone: true });
                setConfirmAnyone(false);
              }}
            >
              Allow anyone
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
