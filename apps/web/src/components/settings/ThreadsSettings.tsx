import { InfoIcon, PlusIcon, XIcon } from "lucide-react";
import {
  type ClaudeWorkflowSize,
  type ModelSelection,
  type NewThreadRoomAgent,
  type NewWorktreeBaseFrom,
  ProviderDriverKind,
  ProviderInstanceId,
  ROOM_AGENT_ROLE_MAX_LENGTH,
} from "@threadlines/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@threadlines/contracts/settings";
import { AGENT_INVITES_LABELS, AGENT_THREADS_LABELS } from "@threadlines/shared/appPlaces";
import { createModelSelection } from "@threadlines/shared/model";
import { agentInvitesChoice, agentThreadsMode } from "@threadlines/shared/serverSettings";
import * as Equal from "effect/Equal";
import { useState } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { roomsEnabledFor } from "../../hooks/useRoomsEnabled";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  resolveDefaultTextGenerationBackupModelSelectionState,
  resolveTextGenerationBackupModelSelectionState,
} from "../../modelSelection";
import { canRunOnComputer } from "../../newThreadDefaults";
import { deriveDisplayProviderInstanceEntries } from "../../providerInstances";
import { useServerProviders } from "../../rpc/serverState";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { NewWorktreeBranchPicker } from "./NewWorktreeBranchPicker";
import {
  ModelSelectionControl,
  TextGenerationModelControl,
  textGenerationInstanceEntries,
} from "./TextGenerationModelControl";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
/** Section note on a phone, where these settings belong to the paired computer. */
const PAIRED_COMPUTER_NOTE = "Applies to your paired computer.";

/**
 * Settings › Threads: how a new thread starts (its agent, the agents beside
 * it, where it works, whether its agent can start threads of its own), Rooms, the model that writes titles, and what happens
 * when a thread is done. The phone shows the same page; the computer's
 * settings there are the paired computer's.
 */
export function ThreadsSettingsPanel({ surface = "full" }: { surface?: "full" | "phone" }) {
  const computerNote = surface === "phone" ? PAIRED_COMPUTER_NOTE : undefined;
  return (
    <SettingsPageContainer>
      <SettingsPageHeader section="/settings/threads" />
      <SettingsSection place="threads.newThreads" description={computerNote}>
        <NewThreadAgentRow />
        <NewThreadRoomRow />
        <DefaultThreadEnvModeRow />
        <NewWorktreeBaseRow />
        <AgentThreadsRow />
        <AgentPagesRow />
        <ClaudeArtifactsRow />
        <ClaudeWorkflowSizeRow />
        <ClaudeSuggestionsRow />
        <CommandRequestsRow />
        <StartAgentsWhileTypingRow />
      </SettingsSection>

      <SettingsSection place="threads.rooms" description={computerNote}>
        <RoomsRow />
        <AgentInvitesRow />
      </SettingsSection>

      <SettingsSection place="threads.titlesAndWriting" description={computerNote}>
        <WritingModelRows />
      </SettingsSection>

      <SettingsSection place="threads.whenDone">
        <WrapUpIdleThreadsRow />
        <WrapUpMergedThreadsRow />
        <WrapUpChildThreadsRow />
        <ConfirmArchiveRow />
        <ConfirmDeleteRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/**
 * Keys for the agent list. Agents get ids only when a thread is opened, so
 * an agent here is its model, numbered among agents on the same model.
 */
function withListKeys(agents: ReadonlyArray<NewThreadRoomAgent>) {
  const seen = new Map<string, number>();
  return agents.map((agent, index) => {
    const base = `${agent.modelSelection.instanceId}:${agent.modelSelection.model}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { agent, key: `${base}#${count}`, index };
  });
}

/** Why a default can't be used on this computer right now, or null. */
function unusableDefaultNote(
  providers: ReturnType<typeof useServerProviders>,
  selection: ModelSelection,
  fallback: string,
): string | null {
  if (canRunOnComputer(providers, selection.instanceId)) return null;
  const entry = deriveDisplayProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const name = entry?.displayName ?? "This provider";
  return entry ? `${name} is turned off. ${fallback}` : `${name} isn't set up here. ${fallback}`;
}

/** The model and reasoning a new thread starts with, or the device's last used. */
function NewThreadAgentRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const instanceEntries = deriveDisplayProviderInstanceEntries(serverProviders);
  const selection = settings.newThreadModelSelection;
  // Where the picker opens: a provider that is turned on.
  const firstInstanceId = (instanceEntries.find((entry) => entry.enabled) ?? instanceEntries[0])
    ?.instanceId;
  const unusable =
    selection === null
      ? null
      : unusableDefaultNote(
          serverProviders,
          selection,
          "New threads use the last-used model until it's back.",
        );
  return (
    <SettingsRow
      place="threads.agent"
      description={
        selection === null
          ? "New threads start with the model you picked last on this device."
          : "Every new thread starts with this model and reasoning."
      }
      status={unusable}
      resetAction={
        selection !== null ? (
          <SettingResetButton
            label="new thread agent"
            onClick={() => updateSettings({ newThreadModelSelection: null })}
          />
        ) : null
      }
      control={
        selection !== null || firstInstanceId !== undefined ? (
          <ModelSelectionControl
            selection={
              selection ??
              createModelSelection(firstInstanceId ?? ProviderInstanceId.make("codex"), "")
            }
            settings={settings}
            serverProviders={serverProviders}
            instanceEntries={instanceEntries}
            onSelectionChange={(next) => updateSettings({ newThreadModelSelection: next })}
            leadingChoice={{
              label: "Last used",
              description: "Whatever you picked last on this device",
              selected: selection === null,
              onSelect: () => updateSettings({ newThreadModelSelection: null }),
            }}
          />
        ) : null
      }
    />
  );
}

/** The agents every new thread starts with, beside its own. */
function NewThreadRoomRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const instanceEntries = deriveDisplayProviderInstanceEntries(serverProviders);
  const roomsOn = roomsEnabledFor(settings);
  const agents = settings.newThreadRoomAgents;
  // Where the picker opens: a provider that is turned on.
  const firstInstanceId = (instanceEntries.find((entry) => entry.enabled) ?? instanceEntries[0])
    ?.instanceId;
  const write = (next: ReadonlyArray<NewThreadRoomAgent>) =>
    updateSettings({ newThreadRoomAgents: [...next] });
  const replaceAt = (index: number, agent: NewThreadRoomAgent) =>
    write(agents.map((current, at) => (at === index ? agent : current)));

  return (
    <SettingsRow
      place="threads.room"
      description={
        roomsOn
          ? "Other agents every new thread starts with. They stay quiet until you or the agent asks them something."
          : "Turn on Rooms below to start threads with more than one agent."
      }
      resetAction={
        agents.length > 0 ? (
          <SettingResetButton label="new thread room" onClick={() => write([])} />
        ) : null
      }
      control={
        firstInstanceId !== undefined ? (
          <ProviderModelPicker
            activeInstanceId={firstInstanceId}
            model=""
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={getCustomModelOptionsByInstance(settings, serverProviders)}
            disabled={!roomsOn}
            triggerVariant="outline"
            triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
            triggerContent={
              <span className="flex items-center gap-1.5">
                <PlusIcon aria-hidden="true" className="size-3.5" />
                <span>Add agent</span>
              </span>
            }
            onInstanceModelChange={(instanceId, model) =>
              write([...agents, { modelSelection: createModelSelection(instanceId, model) }])
            }
          />
        ) : null
      }
    >
      <div className={roomsOn ? "pt-1.5 pb-2.5" : "pointer-events-none pt-1.5 pb-2.5 opacity-50"}>
        {agents.length === 0 ? (
          <p className="py-1 text-[12.5px] text-muted-foreground">
            No other agents. New threads start with one agent.
          </p>
        ) : (
          <>
            <ul
              className="divide-y divide-group-divider"
              aria-label="Agents new threads start with"
            >
              {withListKeys(agents).map(({ agent, key, index }) => {
                const unusable = unusableDefaultNote(
                  serverProviders,
                  agent.modelSelection,
                  "New threads start without this agent until it's back.",
                );
                return (
                  <li key={key} className="flex flex-col gap-0.5 py-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ModelSelectionControl
                        variant="ghost"
                        selection={agent.modelSelection}
                        settings={settings}
                        serverProviders={serverProviders}
                        instanceEntries={instanceEntries}
                        onSelectionChange={(modelSelection) =>
                          replaceAt(index, { ...agent, modelSelection })
                        }
                      />
                      <DraftInput
                        size="sm"
                        className="w-32 text-[13px]"
                        value={agent.role ?? ""}
                        placeholder="Name"
                        maxLength={ROOM_AGENT_ROLE_MAX_LENGTH}
                        spellCheck={false}
                        aria-label={`Name for agent ${index + 1}`}
                        onCommit={(typed) => {
                          const role = typed.trim().slice(0, ROOM_AGENT_ROLE_MAX_LENGTH);
                          const { role: _previous, ...rest } = agent;
                          if ((agent.role ?? "") === role) return;
                          replaceAt(index, role.length > 0 ? { ...rest, role } : rest);
                        }}
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="ms-auto text-muted-foreground hover:text-foreground"
                        aria-label={`Remove agent ${index + 1}`}
                        onClick={() => write(agents.filter((_, at) => at !== index))}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                    {unusable ? (
                      <p className="ps-2 text-[11.5px] text-muted-foreground">{unusable}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="flex items-center gap-1.5 pt-1.5 text-[11.5px] text-muted-foreground">
              <InfoIcon aria-hidden="true" className="size-3 shrink-0" />
              Threads that start with other agents can't be reverted.
            </p>
          </>
        )}
      </div>
    </SettingsRow>
  );
}

function DefaultThreadEnvModeRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.startIn"
      resetAction={
        settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
          <SettingResetButton
            label="start in"
            onClick={() =>
              updateSettings({
                defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={settings.defaultThreadEnvMode}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree") {
              updateSettings({ defaultThreadEnvMode: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
            <SelectValue>
              {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="local">Local</SelectItem>
            <SelectItem value="worktree">New worktree</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

const NEW_WORKTREE_BASE_OPTIONS = [
  {
    value: "default",
    label: "Default branch",
    description: "Each new worktree starts from the project's default branch, usually main.",
  },
  {
    value: "current",
    label: "Current branch",
    description: "Each new worktree starts from the branch your project folder is on.",
  },
  {
    value: "named",
    label: "Another branch",
    description:
      "Each new worktree starts from this branch, or the default branch where it's missing.",
  },
] as const satisfies ReadonlyArray<{
  value: NewWorktreeBaseFrom;
  label: string;
  description: string;
}>;

/** Where a new worktree starts when the thread's branch picker is left alone. */
function NewWorktreeBaseRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const base = settings.newWorktreeBase;
  const selected =
    NEW_WORKTREE_BASE_OPTIONS.find((option) => option.value === base.from) ??
    NEW_WORKTREE_BASE_OPTIONS[0];
  return (
    <SettingsRow
      place="threads.worktreesFrom"
      description={
        base.from === "named" && base.branch.length === 0
          ? "Pick a branch. Until you do, new worktrees start from the default branch."
          : selected.description
      }
      resetAction={
        base.from !== DEFAULT_UNIFIED_SETTINGS.newWorktreeBase.from ? (
          <SettingResetButton
            label="new worktrees from"
            onClick={() =>
              updateSettings({ newWorktreeBase: DEFAULT_UNIFIED_SETTINGS.newWorktreeBase })
            }
          />
        ) : null
      }
      control={
        <>
          {base.from === "named" ? (
            <NewWorktreeBranchPicker
              className="w-full sm:w-44"
              value={base.branch}
              open={branchPickerOpen}
              onOpenChange={setBranchPickerOpen}
              onChange={(branch) => updateSettings({ newWorktreeBase: { ...base, branch } })}
            />
          ) : null}
          <Select
            value={base.from}
            onValueChange={(value) => {
              const option = NEW_WORKTREE_BASE_OPTIONS.find((entry) => entry.value === value);
              if (!option) return;
              updateSettings({ newWorktreeBase: { ...base, from: option.value } });
              // Another branch means nothing until one is picked.
              if (option.value === "named" && base.branch.length === 0) {
                setBranchPickerOpen(true);
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="New worktrees start from">
              <SelectValue>{selected.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {NEW_WORKTREE_BASE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </>
      }
    />
  );
}

function RoomsRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const roomsOn = roomsEnabledFor(settings);
  return (
    <SettingsRow
      place="threads.enableRooms"
      description="Let a thread hold more than one agent. Rooms have no revert. Applies on every device using this computer."
      resetAction={
        !roomsOn ? (
          <SettingResetButton label="rooms" onClick={() => updateSettings({ enableRooms: true })} />
        ) : null
      }
      control={
        <Switch
          checked={roomsOn}
          onCheckedChange={(checked) => updateSettings({ enableRooms: Boolean(checked) })}
          aria-label="Enable rooms"
        />
      }
    />
  );
}

function AgentPagesRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const pagesOn = settings.enableAgentPages !== false;
  return (
    <SettingsRow
      place="threads.agentPages"
      resetAction={
        !pagesOn ? (
          <SettingResetButton
            label="agent pages"
            onClick={() => updateSettings({ enableAgentPages: true })}
          />
        ) : null
      }
      control={
        <Switch
          checked={pagesOn}
          onCheckedChange={(checked) => updateSettings({ enableAgentPages: Boolean(checked) })}
          aria-label="Enable agent pages"
        />
      }
    />
  );
}

/** `ask_user_to_run` (docs/terminal-command-runs.md): on unless turned off. */
function CommandRequestsRow() {
  const settings = useSettings();
  const requestsOn = settings.enableCommandRequests !== false;
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.commandRequests"
      resetAction={
        !requestsOn ? (
          <SettingResetButton
            label="command requests"
            onClick={() => updateSettings({ enableCommandRequests: true })}
          />
        ) : null
      }
      control={
        <Switch
          checked={requestsOn}
          onCheckedChange={(checked) => updateSettings({ enableCommandRequests: Boolean(checked) })}
          aria-label="Enable command requests"
        />
      }
    />
  );
}

/** Early agent starts (docs/early-agent-start.md): on unless turned off. */
function StartAgentsWhileTypingRow() {
  const settings = useSettings();
  const startOn = settings.startAgentsWhileTyping !== false;
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.startWhileTyping"
      resetAction={
        !startOn ? (
          <SettingResetButton
            label="start agents while you type"
            onClick={() => updateSettings({ startAgentsWhileTyping: true })}
          />
        ) : null
      }
      control={
        <Switch
          checked={startOn}
          onCheckedChange={(checked) =>
            updateSettings({ startAgentsWhileTyping: Boolean(checked) })
          }
          aria-label="Start agents while you type"
        />
      }
    />
  );
}

/**
 * Claude's own publishing, beside agent pages: off unless chosen, because it
 * uploads the page. It rides on agent pages, so it is off while they are.
 */
function ClaudeArtifactsRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const pagesOn = settings.enableAgentPages !== false;
  const artifactsOn = settings.enableClaudeArtifacts === true;
  return (
    <SettingsRow
      place="threads.claudeArtifacts"
      description={
        pagesOn
          ? "Claude can also publish a page to claude.ai for a link you can share, which uploads it to Anthropic."
          : "Turn on agent pages to use this."
      }
      resetAction={
        artifactsOn ? (
          <SettingResetButton
            label="Claude artifacts"
            onClick={() => updateSettings({ enableClaudeArtifacts: false })}
          />
        ) : null
      }
      control={
        <Switch
          checked={artifactsOn && pagesOn}
          disabled={!pagesOn}
          onCheckedChange={(checked) => updateSettings({ enableClaudeArtifacts: Boolean(checked) })}
          aria-label="Enable Claude artifacts"
        />
      }
    />
  );
}

const CLAUDE_WORKFLOW_SIZE_LABELS: Record<ClaudeWorkflowSize, string> = {
  default: "Claude's default",
  small: "Small",
  medium: "Medium",
  large: "Large",
  unrestricted: "Any",
};

/** What each size aims for, in Claude's own terms. */
const CLAUDE_WORKFLOW_SIZE_NOTES: Record<ClaudeWorkflowSize, string> = {
  default:
    "How many agents Claude aims for in a workflow. Its default is fewer than 10, or 5 on the Pro plan.",
  small: "Claude aims for fewer than 5 agents in a workflow.",
  medium: "Claude aims for fewer than 10 agents in a workflow.",
  large: "Claude aims for fewer than 50 agents in a workflow.",
  unrestricted: "Claude sizes each workflow to the task, with no limit on agents.",
};

function isClaudeWorkflowSize(value: unknown): value is ClaudeWorkflowSize {
  return typeof value === "string" && Object.hasOwn(CLAUDE_WORKFLOW_SIZE_LABELS, value);
}

/**
 * How many agents Claude aims for when it writes a workflow (Ultracode, or a
 * request for one), for every Claude account. A setting of this computer's
 * server, read before each message, so running threads follow it from their
 * next message.
 */
function ClaudeWorkflowSizeRow() {
  const size = useSettings((settings) => settings.claudeWorkflowSize);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.claudeWorkflowSize"
      description={CLAUDE_WORKFLOW_SIZE_NOTES[size]}
      resetAction={
        size !== "default" ? (
          <SettingResetButton
            label="Claude workflow size"
            onClick={() => updateSettings({ claudeWorkflowSize: "default" })}
          />
        ) : null
      }
      control={
        <Select
          value={size}
          onValueChange={(value) => {
            if (isClaudeWorkflowSize(value)) {
              updateSettings({ claudeWorkflowSize: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Claude workflow size">
            <SelectValue>{CLAUDE_WORKFLOW_SIZE_LABELS[size]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(CLAUDE_WORKFLOW_SIZE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/**
 * Claude skips suggesting the user's next message while the user is on track
 * to run out of usage early; on keeps the suggestions coming. For every Claude
 * account, read before each message, so running threads follow it from their
 * next message.
 */
function ClaudeSuggestionsRow() {
  const on = useSettings((settings) => settings.claudeSuggestionsWhenUsageRunsFast);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.claudeSuggestions"
      description="Claude stops suggesting your next message (the gray text you can take with Tab) when you're on track to run out of usage early. Turn this on to keep them. Each one uses a little usage."
      resetAction={
        on ? (
          <SettingResetButton
            label="Keep Claude's suggestions when you're using a lot"
            onClick={() => updateSettings({ claudeSuggestionsWhenUsageRunsFast: false })}
          />
        ) : null
      }
      control={
        <Switch
          checked={on}
          onCheckedChange={(checked) =>
            updateSettings({ claudeSuggestionsWhenUsageRunsFast: Boolean(checked) })
          }
          aria-label="Keep Claude's suggestions when you're using a lot"
        />
      }
    />
  );
}

/**
 * Whether the thread's agent may bring in another agent for a review
 * (docs/design/rooms-agent-invites.md). A setting of this computer's server:
 * the agents ask through it.
 */
function AgentInvitesRow() {
  const mode = useSettings((settings) => agentInvitesChoice(settings));
  const roomsOn = useSettings((settings) => roomsEnabledFor(settings));
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.agentInvites"
      description={
        !roomsOn
          ? "Turn on Rooms to let the thread's agent bring in another model to review its work."
          : mode === "auto"
            ? "The thread's agent can bring in another model to review its work without asking you. That can spend another provider's quota, and one it adds as a teammate turns revert off for good."
            : mode === "ask"
              ? "The thread's agent can ask to bring in another model to review its work. You decide each time: a one-off review, adding it to the thread, or not now."
              : "The thread's agent never brings in another model."
      }
      resetAction={
        mode !== "ask" ? (
          <SettingResetButton
            label="agents bringing in other agents"
            onClick={() => updateSettings({ agentInvites: "ask" })}
          />
        ) : null
      }
      control={
        <Select
          value={mode}
          disabled={!roomsOn}
          onValueChange={(value) => {
            if (value === "off" || value === "ask" || value === "auto") {
              updateSettings({ agentInvites: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Agents bringing in other agents">
            <SelectValue>{AGENT_INVITES_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="off">{AGENT_INVITES_LABELS.off}</SelectItem>
            <SelectItem value="ask">{AGENT_INVITES_LABELS.ask}</SelectItem>
            <SelectItem value="auto">{AGENT_INVITES_LABELS.auto}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

/**
 * Whether the thread's agent may start threads of its own
 * (docs/design/child-threads.md). A setting of this computer's server, like
 * invites, but independent of Rooms: a thread with one agent can start them.
 */
function AgentThreadsRow() {
  const mode = useSettings((settings) => agentThreadsMode(settings));
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.agentThreads"
      description={
        mode === "auto"
          ? "The thread's agent can start threads of its own and change scheduled tasks, without asking you."
          : mode === "ask"
            ? "The thread's agent can ask to start threads of its own or change scheduled tasks, and you decide each time."
            : "The thread's agent never starts threads of its own or changes scheduled tasks."
      }
      resetAction={
        mode !== "ask" ? (
          <SettingResetButton
            label="agents can start threads"
            onClick={() => updateSettings({ agentThreads: "ask" })}
          />
        ) : null
      }
      control={
        <Select
          value={mode}
          onValueChange={(value) => {
            if (value === "off" || value === "ask" || value === "auto") {
              updateSettings({ agentThreads: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Agents can start threads">
            <SelectValue>{AGENT_THREADS_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="off">{AGENT_THREADS_LABELS.off}</SelectItem>
            <SelectItem value="ask">{AGENT_THREADS_LABELS.ask}</SelectItem>
            <SelectItem value="auto">{AGENT_THREADS_LABELS.auto}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** The model that writes thread titles (and source control text by default), and its backup. */
function WritingModelRows() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const instanceEntries = textGenerationInstanceEntries(serverProviders);
  const primaryDriverKind =
    instanceEntries.find((entry) => entry.instanceId === textGenerationModelSelection.instanceId)
      ?.driverKind ?? DEFAULT_DRIVER_KIND;
  const backupSelection = resolveTextGenerationBackupModelSelectionState(
    settings,
    serverProviders,
    textGenerationModelSelection,
  );
  const defaultBackupSelection = resolveDefaultTextGenerationBackupModelSelectionState(
    settings,
    serverProviders,
    textGenerationModelSelection,
  );
  // The backup must sit on a different provider than the writing model.
  const backupInstanceEntries = instanceEntries.filter(
    (entry) => entry.driverKind !== primaryDriverKind,
  );
  const isWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackupDirty = !Equal.equals(
    settings.textGenerationBackupModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationBackupModelSelection ?? null,
  );

  return (
    <>
      <SettingsRow
        place="threads.writingModel"
        resetAction={
          isWritingModelDirty ? (
            <SettingResetButton
              label="writing model"
              onClick={() =>
                updateSettings({
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          <TextGenerationModelControl
            selection={textGenerationModelSelection}
            settings={settings}
            serverProviders={serverProviders}
            instanceEntries={instanceEntries}
            onSelectionChange={(nextSelection, change) => {
              const nextPrimarySelection = resolveAppModelSelectionState(
                { ...settings, textGenerationModelSelection: nextSelection },
                serverProviders,
              );
              updateSettings({
                textGenerationModelSelection: nextPrimarySelection,
                // Switching providers can invalidate the backup (it must sit
                // on a different driver), so re-resolve it alongside.
                ...(change === "instanceModel" &&
                settings.textGenerationBackupModelSelection !== null
                  ? {
                      textGenerationBackupModelSelection:
                        resolveTextGenerationBackupModelSelectionState(
                          { ...settings, textGenerationModelSelection: nextPrimarySelection },
                          serverProviders,
                          nextPrimarySelection,
                        ),
                    }
                  : {}),
              });
            }}
          />
        }
      />
      <SettingsRow
        place="threads.backupWritingModel"
        resetAction={
          isBackupDirty ? (
            <SettingResetButton
              label="backup writing model"
              onClick={() =>
                updateSettings({
                  textGenerationBackupModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationBackupModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {backupSelection ? (
              <TextGenerationModelControl
                selection={backupSelection}
                settings={settings}
                serverProviders={serverProviders}
                instanceEntries={backupInstanceEntries}
                onSelectionChange={(nextSelection) => {
                  const nextBackupSelection = resolveTextGenerationBackupModelSelectionState(
                    { ...settings, textGenerationBackupModelSelection: nextSelection },
                    serverProviders,
                    textGenerationModelSelection,
                  );
                  if (!nextBackupSelection) return;
                  updateSettings({ textGenerationBackupModelSelection: nextBackupSelection });
                }}
              />
            ) : defaultBackupSelection ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() =>
                  updateSettings({ textGenerationBackupModelSelection: defaultBackupSelection })
                }
              >
                <PlusIcon className="size-3.5" />
                <span>Add backup</span>
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">No different provider ready</span>
            )}
          </div>
        }
      />
    </>
  );
}

function WrapUpIdleThreadsRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      id="wrap-up-idle-threads"
      place="threads.wrapUpIdle"
      resetAction={
        settings.wrapUpIdleThreads !== DEFAULT_UNIFIED_SETTINGS.wrapUpIdleThreads ? (
          <SettingResetButton
            label="wrap up idle threads"
            onClick={() =>
              updateSettings({ wrapUpIdleThreads: DEFAULT_UNIFIED_SETTINGS.wrapUpIdleThreads })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wrapUpIdleThreads}
          onCheckedChange={(checked) => updateSettings({ wrapUpIdleThreads: Boolean(checked) })}
          aria-label="Wrap up idle threads"
        />
      }
    />
  );
}

function WrapUpMergedThreadsRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      id="wrap-up-merged-threads"
      place="threads.wrapUpMerged"
      description="Move a thread to Wrapped when its pull request merges or closes, unless it's pinned. A new message brings it back, and a thread's pull request row can say otherwise."
      resetAction={
        settings.wrapUpThreadsOnPullRequestSettled !==
        DEFAULT_UNIFIED_SETTINGS.wrapUpThreadsOnPullRequestSettled ? (
          <SettingResetButton
            label="wrap up merged threads"
            onClick={() =>
              updateSettings({
                wrapUpThreadsOnPullRequestSettled:
                  DEFAULT_UNIFIED_SETTINGS.wrapUpThreadsOnPullRequestSettled,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wrapUpThreadsOnPullRequestSettled}
          onCheckedChange={(checked) =>
            updateSettings({ wrapUpThreadsOnPullRequestSettled: Boolean(checked) })
          }
          aria-label="Wrap up merged threads"
        />
      }
    />
  );
}

function WrapUpChildThreadsRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      id="wrap-up-finished-child-threads"
      place="threads.wrapUpChildren"
      resetAction={
        settings.wrapUpChildThreadsOnFinish !==
        DEFAULT_UNIFIED_SETTINGS.wrapUpChildThreadsOnFinish ? (
          <SettingResetButton
            label="wrap up finished child threads"
            onClick={() =>
              updateSettings({
                wrapUpChildThreadsOnFinish: DEFAULT_UNIFIED_SETTINGS.wrapUpChildThreadsOnFinish,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wrapUpChildThreadsOnFinish}
          onCheckedChange={(checked) =>
            updateSettings({ wrapUpChildThreadsOnFinish: Boolean(checked) })
          }
          aria-label="Wrap up finished child threads"
        />
      }
    />
  );
}

function ConfirmArchiveRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.confirmArchive"
      resetAction={
        settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
          <SettingResetButton
            label="confirm archive"
            onClick={() =>
              updateSettings({
                confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.confirmThreadArchive}
          onCheckedChange={(checked) => updateSettings({ confirmThreadArchive: Boolean(checked) })}
          aria-label="Confirm thread archiving"
        />
      }
    />
  );
}

function ConfirmDeleteRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="threads.confirmDelete"
      resetAction={
        settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
          <SettingResetButton
            label="confirm delete"
            onClick={() =>
              updateSettings({ confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.confirmThreadDelete}
          onCheckedChange={(checked) => updateSettings({ confirmThreadDelete: Boolean(checked) })}
          aria-label="Confirm thread deletion"
        />
      }
    />
  );
}
