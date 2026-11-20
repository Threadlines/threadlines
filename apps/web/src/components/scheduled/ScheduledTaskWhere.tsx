import type { EnvironmentId, ScheduledTaskCheckout, ThreadId } from "@threadlines/contracts";
import { roomAgentKey } from "@threadlines/shared/threadParticipants";
import { MessagesSquareIcon } from "lucide-react";

import type { ScheduledTaskEnvironment } from "../../lib/scheduledTasksState";
import type { Project, SidebarThreadSummary } from "../../types";
import { ProjectFavicon } from "../ProjectFavicon";
import { InlinePickerTrigger } from "../ui/inline-picker";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import type { ContinuedAgent } from "./useScheduledPage";

/** How many of a project's threads "Continue a thread" lists, most recent first. */
const LISTED_THREADS = 50;

const projectName = (project: Project) =>
  project.kind === "general-chat" ? "General Chats" : project.name;

/** A project as the app's other project pickers show it: its logo (General Chats its own glyph) and name. */
function ProjectLabel({ project }: { readonly project: Project }) {
  return (
    <>
      {project.kind === "general-chat" ? (
        <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ProjectFavicon
          cwd={project.cwd}
          environmentId={project.environmentId}
          name={project.name}
        />
      )}
      <span className="min-w-0 truncate">{projectName(project)}</span>
    </>
  );
}

/**
 * The editor's heading, as the new-thread screen words its own: "New task in
 * [project]", the project a menu of the chosen computer's projects.
 */
export function TaskProjectHeading({
  editing,
  projects,
  selected,
  onSelect,
}: {
  readonly editing: boolean;
  readonly projects: ReadonlyArray<Project>;
  readonly selected: Project | undefined;
  readonly onSelect: (project: Project) => void;
}) {
  return (
    <h1 className="max-w-full px-1 text-center text-xl tracking-tight text-foreground">
      {editing ? "Edit task in " : "New task in "}
      <Menu>
        <InlinePickerTrigger aria-label="Project" data-testid="scheduled-form-project">
          {selected ? <ProjectLabel project={selected} /> : "choose a project"}
        </InlinePickerTrigger>
        <MenuPopup align="center" className="max-w-[min(20rem,calc(100vw-2rem))]">
          {projects.length === 0 ? (
            <MenuItem disabled>No projects on this computer</MenuItem>
          ) : (
            <MenuRadioGroup value={selected?.id ?? ""}>
              {projects.map((project) => (
                <MenuRadioItem
                  key={project.id}
                  value={project.id}
                  title={project.kind === "general-chat" ? undefined : project.cwd}
                  onClick={() => onSelect(project)}
                >
                  <ProjectLabel project={project} />
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
        </MenuPopup>
      </Menu>
    </h1>
  );
}

const CHECKOUT_OPTIONS: ReadonlyArray<{
  readonly value: ScheduledTaskCheckout;
  readonly label: string;
  readonly inSentence: string;
  readonly description: string;
}> = [
  {
    value: "local",
    label: "Local checkout",
    inSentence: "the local checkout",
    description: "The project folder as it is, your uncommitted changes included.",
  },
  {
    value: "worktree",
    label: "New worktree",
    inSentence: "a new worktree",
    description: "A new git worktree for each run, so runs never touch your checkout.",
  },
];

/** Two lines in a menu row: what to pick, and what it means. */
function OptionText({
  label,
  description,
}: {
  readonly label: string;
  readonly description: string;
}) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="font-medium">{label}</span>
      <span className="text-xs leading-4 text-muted-foreground">{description}</span>
    </span>
  );
}

/**
 * Where each run goes, as one sentence under the editor: "Each run starts [a
 * new thread] in [the local checkout] on [MacBook Pro]", or "Each run
 * continues [a thread] and goes to [an agent] on [MacBook Pro]". Each bracket
 * is a menu. The checkout is left out where it can't apply (General Chats, a
 * continued thread), and the computer is plain words where it can't change.
 */
export function TaskRunsSentence({
  isEvent,
  target,
  threadId,
  threadParticipantId,
  checkout,
  showCheckout,
  threads,
  agents,
  environments,
  environmentId,
  computerFixed,
  onNewThread,
  onContinueThread,
  onAgent,
  onCheckout,
  onComputer,
}: {
  readonly isEvent: boolean;
  readonly target: "new_thread" | "thread";
  readonly threadId: ThreadId | null;
  readonly threadParticipantId: ContinuedAgent["id"];
  readonly checkout: ScheduledTaskCheckout;
  readonly showCheckout: boolean;
  /** The project's open threads, most recent first. */
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  /** The continued thread's agents, where it has a room. */
  readonly agents: ReadonlyArray<ContinuedAgent>;
  readonly environments: ReadonlyArray<ScheduledTaskEnvironment>;
  readonly environmentId: EnvironmentId | null;
  /** The task is saved on its computer (editing), or there is no other to pick. */
  readonly computerFixed: boolean;
  readonly onNewThread: () => void;
  readonly onContinueThread: (threadId: ThreadId) => void;
  readonly onAgent: (agent: ContinuedAgent) => void;
  readonly onCheckout: (checkout: ScheduledTaskCheckout) => void;
  readonly onComputer: (environmentId: EnvironmentId) => void;
}) {
  const continuing = target === "thread";
  const thread = threads.find((entry) => entry.id === threadId);
  const goesTo = agents.find((agent) => agent.id === threadParticipantId);
  const computerLabel =
    environments.find((entry) => entry.environmentId === environmentId)?.label ?? null;
  const checkoutOption =
    CHECKOUT_OPTIONS.find((option) => option.value === checkout) ?? CHECKOUT_OPTIONS[0]!;

  const threadMenu = (
    <Menu>
      <InlinePickerTrigger
        aria-label={isEvent ? "Each event" : "Each run"}
        data-testid="scheduled-form-target"
        labelClassName="font-normal"
      >
        <span className="min-w-0 truncate">
          {continuing ? (thread?.title ?? "a thread you choose") : "a new thread"}
        </span>
      </InlinePickerTrigger>
      <MenuPopup align="center" className="w-[min(22rem,calc(100vw-2rem))]">
        <MenuRadioGroup value={continuing ? (threadId ?? "") : "new"}>
          <MenuRadioItem value="new" className="py-1.5" onClick={onNewThread}>
            <OptionText
              label="A new thread"
              description={`${isEvent ? "Each event" : "Each run"} starts a thread of its own.`}
            />
          </MenuRadioItem>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Continue a thread</MenuGroupLabel>
            {threads.length === 0 ? (
              <MenuItem disabled>No open threads in this project</MenuItem>
            ) : (
              threads.slice(0, LISTED_THREADS).map((entry) => (
                <MenuRadioItem
                  key={entry.id}
                  value={entry.id}
                  onClick={() => onContinueThread(entry.id)}
                >
                  <span className="min-w-0 truncate">{entry.title}</span>
                </MenuRadioItem>
              ))
            )}
          </MenuGroup>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );

  const agentMenu =
    continuing && agents.length > 0 ? (
      <Menu>
        <InlinePickerTrigger
          aria-label="Goes to"
          data-testid="scheduled-form-goes-to"
          labelClassName="font-normal"
        >
          <span className="min-w-0 truncate">
            {goesTo === undefined
              ? "an agent you choose"
              : goesTo.left
                ? `${goesTo.name} (left)`
                : goesTo.name}
          </span>
        </InlinePickerTrigger>
        <MenuPopup align="center" className="max-w-[min(20rem,calc(100vw-2rem))]">
          <MenuGroup>
            <MenuGroupLabel>Which agent in that thread gets each run</MenuGroupLabel>
            <MenuRadioGroup value={roomAgentKey(threadParticipantId)}>
              {agents.map((agent) => (
                <MenuRadioItem
                  key={roomAgentKey(agent.id)}
                  value={roomAgentKey(agent.id)}
                  disabled={agent.left}
                  onClick={() => {
                    if (!agent.left) onAgent(agent);
                  }}
                >
                  {agent.left ? `${agent.name} (left the thread)` : agent.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    ) : null;

  const checkoutMenu = (
    <Menu>
      <InlinePickerTrigger
        aria-label="Runs in"
        data-testid="scheduled-form-checkout"
        labelClassName="font-normal"
      >
        {checkoutOption.inSentence}
      </InlinePickerTrigger>
      <MenuPopup align="center" className="w-[min(20rem,calc(100vw-2rem))]">
        <MenuRadioGroup value={checkout}>
          {CHECKOUT_OPTIONS.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              className="py-1.5"
              onClick={() => onCheckout(option.value)}
            >
              <OptionText label={option.label} description={option.description} />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );

  const computer = computerFixed ? (
    <span className="text-foreground" data-testid="scheduled-form-computer">
      {computerLabel ?? "this computer"}
    </span>
  ) : (
    <Menu>
      <InlinePickerTrigger
        aria-label="Computer"
        data-testid="scheduled-form-computer"
        labelClassName="font-normal"
      >
        {computerLabel ?? "a computer you choose"}
      </InlinePickerTrigger>
      <MenuPopup align="center" className="max-w-[min(20rem,calc(100vw-2rem))]">
        <MenuGroup>
          <MenuGroupLabel>It keeps the task and runs it</MenuGroupLabel>
          <MenuRadioGroup value={environmentId ?? ""}>
            {environments.map((environment) => (
              <MenuRadioItem
                key={environment.environmentId}
                value={environment.environmentId}
                onClick={() => onComputer(environment.environmentId)}
              >
                {environment.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );

  return (
    <p
      className="text-center text-[12.5px] leading-6 text-muted-foreground"
      data-testid="scheduled-form-where"
    >
      {isEvent ? "Each event " : "Each run "}
      {continuing ? "continues " : "starts "}
      {threadMenu}
      {agentMenu ? <> and goes to {agentMenu}</> : null}
      {showCheckout && !continuing ? <> in {checkoutMenu}</> : null} on {computer}
    </p>
  );
}
