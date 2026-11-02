/**
 * Settings › Connections › Assistants › Alerts to a web address
 * (docs/design/assistants.md, steps 4 and 5): the web addresses this computer
 * sends signed alerts to when a thread needs the user, finishes or fails,
 * such as a Grok routine's webhook, in the server's order. One row each: its
 * host, the kinds and projects it gets, and how it's doing (when it last
 * sent, alerts waiting for another try, the receiver refusing it or turning
 * it off). Each address the user added sends a test, copies its signing
 * secret, turns off or on, opens Edit and removes it (after asking); Add a
 * web address opens the same dialog empty. A subscription an assistant made
 * through MCP Events also says who added it and when it must be renewed by,
 * and only removes. AssistantsSection shows it under the same owner-only
 * gate, from the same stream.
 */
import type {
  AssistantAlertTarget,
  AssistantAlertTargetId,
  KnownAssistant,
  OutsideAgentConnection,
  OutsideAgentConnectionId,
  OutsideAgentRef,
} from "@threadlines/contracts";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import {
  describeOutsideAgentFailure,
  readAssistantAlertTargetSecret,
  removeAssistantAlertTarget,
  setAssistantAlertTargetOn,
  testAssistantAlertTarget,
  useThisComputerProjects,
} from "../../environments/outsideAgents/outsideAgents";
import {
  assistantAlertTargetTitles,
  describeAssistantAlertKinds,
  describeAssistantAlertRenewal,
  describeAssistantAlertTargetStatus,
  describeOutsideAgentProjects,
} from "../../environments/outsideAgents/outsideAgents.logic";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { SETTINGS_GROUP_ROW_CLASS, SettingsSection } from "../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { copyWithNotice } from "../ui/copyWithNotice";
import { Dialog } from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { failureNotice, toastManager } from "../ui/toast";
import { AssistantAlertTargetDialogContent } from "./AssistantAlertTargetDialogContent";
import { AssistantMark } from "./AssistantMark";

const ROW_CLASS = cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5");
const LINE_CLASS = "text-[12.5px] leading-[18px]";

/** What a row is doing right now, so its buttons wait for it. */
type RowAction = "test" | "secret" | "on" | "off";

/** The dialog showing: Add, or Edit for one web address. */
type Editing =
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly targetId: AssistantAlertTargetId };

const DIDNT_ANSWER = "Threadlines didn't answer. Try again.";

/** `connections`: the assistants connected, whose marks show beside the subscriptions they made. */
export function AssistantAlertsSection({
  targets,
  connections,
}: {
  readonly targets: ReadonlyArray<AssistantAlertTarget>;
  readonly connections: ReadonlyArray<OutsideAgentConnection>;
}) {
  const projects = useThisComputerProjects();
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const marks = useMemo(
    () =>
      new Map<OutsideAgentConnectionId, KnownAssistant | null>(
        connections.map((connection) => [connection.connectionId, connection.assistant] as const),
      ),
    [connections],
  );
  const titles = useMemo(() => assistantAlertTargetTitles(targets), [targets]);
  const nowMs = useRelativeTimeTick(30_000);
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removingId, setRemovingId] = useState<AssistantAlertTargetId | null>(null);
  // Who made the subscription being removed. Kept after closing, so the dialog
  // keeps its words while it fades out, when the row may already be gone.
  const [removingAddedBy, setRemovingAddedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlyMap<AssistantAlertTargetId, RowAction>>(() => new Map());

  // A web address removed while its Edit or Remove is open closes it.
  const edited =
    editing?.kind === "edit"
      ? (targets.find((target) => target.targetId === editing.targetId) ?? null)
      : null;
  const dialogOpen = editing?.kind === "add" || edited !== null;
  const removing =
    removingId === null ? null : (targets.find((target) => target.targetId === removingId) ?? null);
  const titleOf = (target: AssistantAlertTarget) => titles.get(target.targetId) ?? target.url;
  const askToRemove = (target: AssistantAlertTarget) => {
    setRemovingId(target.targetId);
    setRemovingAddedBy(target.addedBy?.name ?? null);
  };

  const run = async (
    target: AssistantAlertTarget,
    action: RowAction,
    work: () => Promise<void>,
  ) => {
    setBusy((current) => new Map(current).set(target.targetId, action));
    try {
      await work();
    } finally {
      setBusy((current) => {
        const next = new Map(current);
        next.delete(target.targetId);
        return next;
      });
    }
  };

  const sendTest = (target: AssistantAlertTarget) =>
    run(target, "test", async () => {
      try {
        const result = await testAssistantAlertTarget(target.targetId);
        toastManager.add(
          result.outcome === "sent"
            ? { type: "success", title: "Test sent", description: result.detail }
            : failureNotice({ title: "Couldn't send a test", reason: result.detail }),
        );
      } catch (error) {
        toastManager.add(
          failureNotice({
            title: "Couldn't send a test",
            reason: describeOutsideAgentFailure(error, DIDNT_ANSWER),
          }),
        );
      }
    });

  const copySecret = (target: AssistantAlertTarget) =>
    run(target, "secret", async () => {
      let secret: string;
      try {
        secret = await readAssistantAlertTargetSecret(target.targetId);
      } catch (error) {
        toastManager.add(
          failureNotice({
            title: "Couldn't copy signing secret",
            reason: describeOutsideAgentFailure(error, DIDNT_ANSWER),
          }),
        );
        return;
      }
      await copyWithNotice(secret, "signing secret");
    });

  const setOn = (target: AssistantAlertTarget, on: boolean) =>
    run(target, on ? "on" : "off", async () => {
      try {
        await setAssistantAlertTargetOn(target.targetId, on);
      } catch (error) {
        toastManager.add(
          failureNotice({
            title: `Couldn't turn ${on ? "on" : "off"} alerts to ${titleOf(target)}`,
            reason: describeOutsideAgentFailure(error, DIDNT_ANSWER),
          }),
        );
      }
    });

  const remove = async (target: AssistantAlertTarget) => {
    setRemovingId(null);
    try {
      await removeAssistantAlertTarget(target.targetId);
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: `Couldn't remove ${titleOf(target)}`,
          reason: describeOutsideAgentFailure(error, DIDNT_ANSWER),
        }),
      );
    }
  };

  return (
    <>
      <SettingsSection
        place="connections.assistantAlerts"
        description="Threadlines sends a signed alert when a thread needs you, finishes or fails. Paste a Grok routine's webhook here, with its key as the Authorization header."
        headerAction={
          <Button
            size="xs"
            variant="outline"
            onClick={() => setEditing({ kind: "add" })}
            data-testid="assistant-alerts-add"
          >
            Add a web address
          </Button>
        }
        data-testid="assistant-alerts-section"
      >
        {targets.length === 0 ? (
          <div className={ROW_CLASS}>
            <p className={cn(LINE_CLASS, "text-muted-foreground")}>No web addresses yet.</p>
          </div>
        ) : (
          targets.map((target) =>
            target.addedBy !== null ? (
              <SubscriptionRow
                key={target.targetId}
                target={target}
                addedBy={target.addedBy}
                assistant={marks.get(target.addedBy.connectionId) ?? null}
                title={titleOf(target)}
                projects={describeOutsideAgentProjects(target.projectIds, projectNames)}
                renewal={
                  target.expiresAt === null
                    ? null
                    : describeAssistantAlertRenewal(target.expiresAt, nowMs, timestampFormat)
                }
                nowMs={nowMs}
                onRemove={() => askToRemove(target)}
              />
            ) : (
              <AlertTargetRow
                key={target.targetId}
                target={target}
                title={titleOf(target)}
                projects={describeOutsideAgentProjects(target.projectIds, projectNames)}
                nowMs={nowMs}
                busy={busy.get(target.targetId) ?? null}
                onTest={() => void sendTest(target)}
                onCopySecret={() => void copySecret(target)}
                onSetOn={(on) => void setOn(target, on)}
                onEdit={() => setEditing({ kind: "edit", targetId: target.targetId })}
                onRemove={() => askToRemove(target)}
              />
            ),
          )
        )}
      </SettingsSection>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {dialogOpen ? (
          <AssistantAlertTargetDialogContent
            key={edited?.targetId ?? "add"}
            target={edited}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </Dialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingId(null);
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            {removingAddedBy !== null ? (
              <>
                <AlertDialogTitle>Remove this subscription?</AlertDialogTitle>
                <AlertDialogDescription>
                  {removingAddedBy} can subscribe again while it's connected. Remove the assistant
                  to stop it for good.
                </AlertDialogDescription>
              </>
            ) : (
              <>
                <AlertDialogTitle>
                  Remove {removing === null ? null : titleOf(removing)}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Alerts stop going there. Its signing secret and Authorization header are deleted.
                </AlertDialogDescription>
              </>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) void remove(removing);
              }}
              data-testid="assistant-alert-remove-confirm"
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * One web address the user added: its host, then its kinds, projects and
 * quiet status on one line, and what's wrong (in the warning tone) under it.
 * Send a test while it's on, Turn on while it isn't; Edit; the rest in its
 * menu.
 */
function AlertTargetRow({
  target,
  title,
  projects,
  nowMs,
  busy,
  onTest,
  onCopySecret,
  onSetOn,
  onEdit,
  onRemove,
}: {
  readonly target: AssistantAlertTarget;
  readonly title: string;
  /** Its projects, by name. */
  readonly projects: string;
  readonly nowMs: number;
  readonly busy: RowAction | null;
  readonly onTest: () => void;
  readonly onCopySecret: () => void;
  readonly onSetOn: (on: boolean) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const status = describeAssistantAlertTargetStatus(target, nowMs);
  const on = target.state === "on";
  const waiting = busy !== null;
  return (
    <AlertRowLayout
      target={target}
      title={title}
      line={[describeAssistantAlertKinds(target.kinds), projects, status.quiet]
        .filter((part) => part !== null)
        .join(" · ")}
      warning={status.warning}
    >
      {on ? (
        <Button size="xs" variant="outline" disabled={waiting} onClick={onTest}>
          {busy === "test" ? "Sending…" : "Send a test"}
        </Button>
      ) : (
        <Button size="xs" variant="outline" disabled={waiting} onClick={() => onSetOn(true)}>
          {busy === "on" ? "Turning on…" : "Turn on"}
        </Button>
      )}
      <Button size="xs" variant="outline" disabled={waiting} onClick={onEdit}>
        Edit
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              disabled={waiting}
              aria-label={`More for ${title}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-40">
          {on ? null : <MenuItem onClick={onTest}>Send a test</MenuItem>}
          <MenuItem onClick={onCopySecret}>Copy signing secret</MenuItem>
          {on ? <MenuItem onClick={() => onSetOn(false)}>Turn off</MenuItem> : null}
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onRemove}>
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
    </AlertRowLayout>
  );
}

/**
 * A subscription an assistant made through MCP Events: its callback's host
 * and path (the whole address on hover), then who added it with their mark,
 * its kind, projects, quiet status and when it must be renewed by, and
 * what's wrong under it as for an address. Its secret is the assistant's and
 * its choices are its own, so Remove is its only action.
 */
function SubscriptionRow({
  target,
  addedBy,
  assistant,
  title,
  projects,
  renewal,
  nowMs,
  onRemove,
}: {
  readonly target: AssistantAlertTarget;
  readonly addedBy: OutsideAgentRef;
  /** The known assistant its connection is; null: none, or its connection isn't in the list. */
  readonly assistant: KnownAssistant | null;
  readonly title: string;
  /** Its projects, by name. */
  readonly projects: string;
  /** "Renews by Nov 9, 3:14 PM" or "Expired"; null: no expiry known. */
  readonly renewal: string | null;
  readonly nowMs: number;
  readonly onRemove: () => void;
}) {
  const status = describeAssistantAlertTargetStatus(target, nowMs);
  const rest = [describeAssistantAlertKinds(target.kinds), projects, status.quiet, renewal].filter(
    (part) => part !== null,
  );
  return (
    <AlertRowLayout
      target={target}
      title={title}
      titleHint={target.url}
      line={
        <>
          <span className="inline-flex items-center gap-1">
            {"Added by "}
            <AssistantMark assistant={assistant} className="size-3" />
            {addedBy.name}
          </span>
          {rest.map((part) => ` · ${part}`).join("")}
        </>
      }
      warning={status.warning}
    >
      <Button size="xs" variant="destructive-outline" onClick={onRemove}>
        Remove
      </Button>
    </AlertRowLayout>
  );
}

/**
 * A row: its title, the quiet line under it and what's wrong in the warning
 * tone, with its actions (`children`) beside them.
 */
function AlertRowLayout({
  target,
  title,
  titleHint,
  line,
  warning,
  children,
}: {
  readonly target: AssistantAlertTarget;
  readonly title: string;
  /** Shown on hovering the title. */
  readonly titleHint?: string;
  readonly line: ReactNode;
  readonly warning: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div className={ROW_CLASS} data-testid={`assistant-alert-row-${target.targetId}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3
            className="truncate text-[13.5px] leading-[19px] font-medium text-foreground"
            title={titleHint}
          >
            {title}
          </h3>
          <p className={cn(LINE_CLASS, "text-muted-foreground")}>{line}</p>
          {warning !== null ? (
            <p
              className={cn(LINE_CLASS, "text-warning-foreground")}
              data-testid={`assistant-alert-warning-${target.targetId}`}
            >
              {warning}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}
