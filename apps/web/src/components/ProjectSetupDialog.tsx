/**
 * "Set up on another computer" (docs/design/fleet.md, Part 8): one dialog for
 * every entry point (the sidebar's project menu, the command palette, the
 * new thread's "Runs on" picker, Move's "Set it up there"). Each asks through
 * openProjectSetupDialog; the host mounted once at the root shows it, and
 * raises a toast when a setup this app started ends while the dialog is
 * closed.
 *
 * The dialog asks the project's computer what to clone and which ignored
 * files could go along, lets the user pick the other computer, the folder,
 * the protocol and the files, then starts the job there and follows it.
 */
import {
  initialProjectSetupFileSelection,
  isProjectSetupCancellable,
  isProjectSetupFinished,
  orderProjectSetupFiles,
  projectSetupCloneOptions,
  projectSetupFilesFit,
  projectSetupPrimaryRemote,
  scopeProjectRef,
  type ProjectSetupTarget,
} from "@threadlines/client-runtime";
import type {
  EnvironmentId,
  ProjectSetupDestination,
  ProjectSetupFileCandidate,
  ProjectSetupId,
  ProjectSetupJob,
  ProjectSetupProtocol,
  ProjectSetupSource,
  ScopedProjectRef,
} from "@threadlines/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import {
  canRetryProjectSetup,
  cancelProjectSetup,
  describeProjectSetupFailure,
  inspectProjectSetupDestination,
  onProjectSetupEnded,
  type ProjectSetupOnDone,
  readProjectSetupSource,
  retryProjectSetup,
  setShownProjectSetup,
  startProjectSetup,
  useProjectSetupJob,
  waitForSetUpProject,
} from "../environments/projectSetups/projectSetups";
import {
  readDefaultProjectSetupFolder,
  readExistingProjectSetupCopy,
  readProjectSetupTargets,
  useProjectSetupTargets,
} from "../environments/projectSetups/projectSetupTargets";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { cn, newProjectSetupId } from "../lib/utils";
import {
  describeProjectSetupDestination,
  describeProjectSetupProgress,
  describeProjectSetupStage,
  formatProjectSetupFileSize,
  isProjectSetupDestinationBlocked,
  projectSetupFilesBlockedReason,
} from "../projectSetup";
import { selectProjectByRef, useStore } from "../store";
import { useComputerLabel } from "./sidebar/linkedComputers";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { stackedThreadToast, toastManager } from "./ui/toast";

type ProjectSetupDialogRequest =
  | {
      /** Each ask starts fresh, even for the same project twice. */
      readonly id: number;
      readonly kind: "new";
      /** The project to copy, on the computer that has it. */
      readonly project: ScopedProjectRef;
      readonly targetEnvironmentId: EnvironmentId | null;
      readonly onDone: ProjectSetupOnDone | null;
    }
  | {
      readonly id: number;
      readonly kind: "job";
      /** The computer the job runs on. */
      readonly environmentId: EnvironmentId;
      readonly setupId: ProjectSetupId;
    };

type ProjectSetupDialogAsk =
  | Omit<Extract<ProjectSetupDialogRequest, { kind: "new" }>, "id">
  | Omit<Extract<ProjectSetupDialogRequest, { kind: "job" }>, "id">;

const useProjectSetupDialogStore = create<{ request: ProjectSetupDialogRequest | null }>(() => ({
  request: null,
}));

function openRequest(ask: ProjectSetupDialogAsk): void {
  const previous = useProjectSetupDialogStore.getState().request;
  useProjectSetupDialogStore.setState({ request: { ...ask, id: (previous?.id ?? 0) + 1 } });
}

/**
 * Opens the dialog to set `project` up on another computer: `target` comes
 * picked when it can take it, and `onDone` runs once the setup ends done (even
 * with the dialog closed by then), with the project it made there.
 */
export function openProjectSetupDialog(input: {
  readonly project: ScopedProjectRef;
  readonly targetEnvironmentId?: EnvironmentId;
  readonly onDone?: ProjectSetupOnDone;
}): void {
  openRequest({
    kind: "new",
    project: input.project,
    targetEnvironmentId: input.targetEnvironmentId ?? null,
    onDone: input.onDone ?? null,
  });
}

/** Opens the dialog on a job already running or finished, on the computer it runs on. */
export function showProjectSetupJob(environmentId: EnvironmentId, setupId: ProjectSetupId): void {
  openRequest({ kind: "job", environmentId, setupId });
}

export function closeProjectSetupDialog(): void {
  useProjectSetupDialogStore.setState({ request: null });
}

/** Mounted once at the root; shows whatever openProjectSetupDialog asks. */
export function ProjectSetupDialogHost() {
  const request = useProjectSetupDialogStore((state) => state.request);
  return (
    <>
      <Dialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) closeProjectSetupDialog();
        }}
      >
        {request ? <ProjectSetupDialogContent key={request.id} request={request} /> : null}
      </Dialog>
      <ProjectSetupEndToasts />
    </>
  );
}

/** Starts a thread in the project a setup made, once this app has heard of it. */
function useStartThreadInSetUpProject() {
  const { handleNewThread } = useNewThreadHandler();
  return useCallback(
    async (ref: ScopedProjectRef): Promise<boolean> => {
      if (!(await waitForSetUpProject(ref))) return false;
      await handleNewThread(ref);
      return true;
    },
    [handleNewThread],
  );
}

/**
 * Tells of a setup this app started that ended while the dialog wasn't
 * showing it: ready, with a way to start a thread there, or failed, with a
 * way back to the dialog.
 */
function ProjectSetupEndToasts() {
  const startThread = useStartThreadInSetUpProject();
  useEffect(
    () =>
      onProjectSetupEnded(({ job, environmentId, label, shown }) => {
        if (shown) return;
        if (job.stage === "done" && job.projectId !== null) {
          const ref = scopeProjectRef(environmentId, job.projectId);
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${job.title} is ready on ${label}`,
              ...(job.warnings.length > 0 ? { description: job.warnings.join(" ") } : {}),
              actionProps: {
                children: "Start a thread there",
                onClick: () =>
                  void startThread(ref).then((started) => {
                    if (started) return;
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: `${label} hasn't shown the new project yet`,
                        description: "Try again in a moment.",
                      }),
                    );
                  }),
              },
              actionVariant: "outline",
            }),
          );
          return;
        }
        if (job.stage === "failed") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Couldn't set up ${job.title} on ${label}`,
              ...(job.error !== null ? { description: job.error } : {}),
              actionProps: {
                children: "Show",
                onClick: () => showProjectSetupJob(environmentId, job.setupId),
              },
              actionVariant: "outline",
            }),
          );
        }
      }),
    [startThread],
  );
  return null;
}

type DialogView =
  | { readonly kind: "form" }
  | {
      readonly kind: "job";
      readonly environmentId: EnvironmentId;
      readonly setupId: ProjectSetupId;
    };

function ProjectSetupDialogContent({ request }: { readonly request: ProjectSetupDialogRequest }) {
  const [view, setView] = useState<DialogView>(
    request.kind === "job"
      ? { kind: "job", environmentId: request.environmentId, setupId: request.setupId }
      : { kind: "form" },
  );
  if (view.kind === "job") {
    return (
      <ProjectSetupJobView
        key={view.setupId}
        environmentId={view.environmentId}
        setupId={view.setupId}
        onRetried={(setupId) =>
          setView({ kind: "job", environmentId: view.environmentId, setupId })
        }
      />
    );
  }
  return request.kind === "new" ? (
    <ProjectSetupForm
      request={request}
      onStarted={(environmentId, setupId) => setView({ kind: "job", environmentId, setupId })}
    />
  ) : null;
}

const FIELD_LABEL_CLASS = "text-xs font-medium text-foreground";

type SourceState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly source: ProjectSetupSource }
  | { readonly status: "failed"; readonly message: string };

/** What the folder field's text would mean, for one computer and one path. */
interface DestinationCheck {
  readonly key: string;
  readonly destination: ProjectSetupDestination | null;
  readonly error: string | null;
}

const DESTINATION_CHECK_DELAY_MS = 300;

function destinationKey(environmentId: EnvironmentId, path: string) {
  return `${environmentId}\u0000${path}`;
}

function ProjectSetupForm({
  request,
  onStarted,
}: {
  readonly request: Extract<ProjectSetupDialogRequest, { kind: "new" }>;
  readonly onStarted: (environmentId: EnvironmentId, setupId: ProjectSetupId) => void;
}) {
  const projectName = useStore((state) => selectProjectByRef(state, request.project)?.name ?? null);
  const sourceLabel = useComputerLabel()(
    request.project.environmentId,
    request.project.environmentId,
  );
  const targets = useProjectSetupTargets(request.project);
  // The computer stays the one asked for or first shown: if it drops out, the
  // dialog says so rather than quietly sending the files somewhere else.
  const [pickedTargetId, setPickedTargetId] = useState<EnvironmentId | null>(
    () =>
      request.targetEnvironmentId ??
      readProjectSetupTargets(request.project)[0]?.environmentId ??
      null,
  );
  const chosenTargetId = pickedTargetId ?? targets[0]?.environmentId ?? null;
  const target = targets.find((candidate) => candidate.environmentId === chosenTargetId) ?? null;
  const lostTargetLabel = useComputerLabel()(
    chosenTargetId ?? request.project.environmentId,
    request.project.environmentId,
  );
  const [sourceState, setSourceState] = useState<SourceState>({ status: "loading" });
  // What the user typed, per computer: switching computers shows each one's own folder.
  const [typedFolders, setTypedFolders] = useState<Readonly<Record<string, string>>>({});
  const [pickedProtocol, setPickedProtocol] = useState<ProjectSetupProtocol | null>(null);
  const [pickedFiles, setPickedFiles] = useState<ReadonlySet<string> | null>(null);
  const [destinationCheck, setDestinationCheck] = useState<DestinationCheck | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const source = await readProjectSetupSource(
          { environmentId: request.project.environmentId, label: sourceLabel },
          request.project.projectId,
        );
        if (active) setSourceState({ status: "ready", source });
      } catch (error) {
        if (!active) return;
        setSourceState({
          status: "failed",
          message: describeProjectSetupFailure(error, `${sourceLabel} didn't answer.`),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [request.project.environmentId, request.project.projectId, sourceLabel]);

  const source = sourceState.status === "ready" ? sourceState.source : null;
  const targetId = target?.environmentId ?? null;
  const targetLabel = target?.label ?? "";
  // Both read the stores as they are: cheap, and current on every render.
  const defaultFolder =
    source !== null && targetId !== null ? readDefaultProjectSetupFolder(targetId, source) : "";
  // A copy of the repository already there is where the project is added from,
  // whatever folder is named (the server holds to that too): show it, fixed.
  const existingCopy =
    source !== null && targetId !== null
      ? readExistingProjectSetupCopy(targetId, source.repositoryKey)
      : null;
  const folder =
    existingCopy ?? (targetId !== null ? typedFolders[targetId] : undefined) ?? defaultFolder;
  const path = folder.trim();
  const currentKey = targetId !== null && path.length > 0 ? destinationKey(targetId, path) : null;
  const check = destinationCheck?.key === currentKey ? destinationCheck : null;

  // What the folder would mean there, asked a moment after typing stops: again
  // for another folder or computer, not each time the computer list redraws.
  useEffect(() => {
    if (source === null || targetId === null || path.length === 0) return;
    const computer = { environmentId: targetId, label: targetLabel };
    const key = destinationKey(targetId, path);
    let active = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const destination = await inspectProjectSetupDestination(computer, {
            path,
            repositoryKey: source.repositoryKey,
            remotes: source.remotes,
          });
          if (active) setDestinationCheck({ key, destination, error: null });
        } catch (error) {
          if (!active) return;
          setDestinationCheck({
            key,
            destination: null,
            error: describeProjectSetupFailure(error, `${targetLabel} couldn't check that folder.`),
          });
        }
      })();
    }, DESTINATION_CHECK_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path, source, targetId, targetLabel]);

  const primaryRemote = source !== null ? projectSetupPrimaryRemote(source) : null;
  const cloneOptions = primaryRemote !== null ? projectSetupCloneOptions(primaryRemote) : [];
  const protocol =
    cloneOptions.find((option) => option.protocol === pickedProtocol)?.protocol ??
    cloneOptions[0]?.protocol ??
    null;
  const cloneUrl = cloneOptions.find((option) => option.protocol === protocol)?.url ?? null;

  const files = useMemo(
    () => (source !== null ? orderProjectSetupFiles(source.files) : []),
    [source],
  );
  const ticked = useMemo(
    () =>
      pickedFiles ??
      (source !== null ? initialProjectSetupFileSelection(source.files) : new Set<string>()),
    [pickedFiles, source],
  );
  const filesAllowed = target?.unprotected === null;
  const sentPaths = filesAllowed
    ? files.filter((file) => ticked.has(file.path)).map((file) => file.path)
    : [];
  const filesFit = !filesAllowed || projectSetupFilesFit(files, ticked);
  const destinationBlocked =
    check?.destination != null && isProjectSetupDestinationBlocked(check.destination.state);
  const canStart =
    source !== null &&
    target !== null &&
    protocol !== null &&
    path.length > 0 &&
    check !== null &&
    !destinationBlocked &&
    filesFit &&
    !starting;

  const start = async () => {
    if (!canStart || source === null || target === null || protocol === null) return;
    setStarting(true);
    setStartError(null);
    const setupId = newProjectSetupId();
    // On screen from now: an end heard before start answers raises no toast.
    setShownProjectSetup(setupId);
    try {
      await startProjectSetup(setupId, {
        source: {
          environmentId: request.project.environmentId,
          projectId: request.project.projectId,
          label: sourceLabel,
        },
        target: { environmentId: target.environmentId, label: target.label },
        sourceInfo: source,
        protocol,
        destinationPath: path,
        filePaths: sentPaths,
        onDone: request.onDone,
      });
      onStarted(target.environmentId, setupId);
    } catch (error) {
      setShownProjectSetup(null);
      setStartError(describeProjectSetupFailure(error, `${target.label} couldn't start it.`));
      setStarting(false);
    }
  };

  const title = projectName ?? source?.title ?? "this project";
  return (
    <DialogPopup className="max-w-lg" data-testid="project-setup-dialog">
      <DialogHeader>
        <DialogTitle>Set up {title} on another computer</DialogTitle>
        <DialogDescription>
          The other computer clones it from its git remote and adds the project.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {sourceState.status === "loading" ? (
          <p className="text-sm text-muted-foreground" data-testid="project-setup-loading">
            Checking what to copy…
          </p>
        ) : sourceState.status === "failed" ? (
          <p role="alert" className="text-sm text-foreground" data-testid="project-setup-refusal">
            {sourceState.message}
          </p>
        ) : targets.length === 0 ? (
          <p className="text-sm text-foreground" data-testid="project-setup-refusal">
            No other computer can take it right now.
          </p>
        ) : target === null ? (
          <>
            <TargetField
              targets={targets}
              target={null}
              disabled={starting}
              onChange={(next) => {
                setPickedTargetId(next);
                setStartError(null);
              }}
            />
            {chosenTargetId !== null ? (
              <p className="text-sm text-foreground" data-testid="project-setup-target-lost">
                {lostTargetLabel} isn't available right now. Pick another computer.
              </p>
            ) : null}
          </>
        ) : source !== null ? (
          <>
            {targets.length > 1 ? (
              <TargetField
                targets={targets}
                target={target}
                disabled={starting}
                onChange={(next) => {
                  setPickedTargetId(next);
                  setStartError(null);
                }}
              />
            ) : null}
            <div className="grid gap-1.5">
              <label className={FIELD_LABEL_CLASS} htmlFor="project-setup-folder">
                Folder on {target.label}
              </label>
              <Input
                id="project-setup-folder"
                value={folder}
                disabled={starting}
                readOnly={existingCopy !== null}
                spellCheck={false}
                autoComplete="off"
                data-testid="project-setup-folder"
                onChange={(event) => {
                  const next = event.target.value;
                  setTypedFolders((current) => ({ ...current, [target.environmentId]: next }));
                  setStartError(null);
                }}
              />
              <p
                className={cn(
                  "text-xs leading-[18px]",
                  destinationBlocked || check?.error ? "text-destructive" : "text-muted-foreground",
                )}
                data-testid="project-setup-destination"
              >
                {existingCopy !== null
                  ? `${target.label} already has this repository here. The project is added from it, keeping its own files.`
                  : path.length === 0
                    ? "Name a folder."
                    : check === null
                      ? "Checking the folder…"
                      : check.destination !== null
                        ? describeProjectSetupDestination(check.destination.state, target.label)
                        : check.error}
              </p>
            </div>
            {cloneOptions.length > 1 && protocol !== null ? (
              <div className="grid gap-1.5">
                <span className={FIELD_LABEL_CLASS}>Clone over</span>
                <SegmentedControl
                  value={protocol}
                  onValueChange={(next) => setPickedProtocol(next)}
                  aria-label="Clone over"
                  disabled={starting}
                >
                  {cloneOptions.map((option) => (
                    <SegmentedControlItem
                      key={option.protocol}
                      value={option.protocol}
                      data-testid={`project-setup-protocol-${option.protocol}`}
                    >
                      {option.protocol === "ssh" ? "SSH" : "HTTPS"}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
                <p
                  className="font-mono text-[11px] leading-4 break-all text-muted-foreground"
                  data-testid="project-setup-clone-url"
                >
                  {cloneUrl}
                </p>
              </div>
            ) : cloneUrl !== null ? (
              <div className="grid gap-1.5">
                <span className={FIELD_LABEL_CLASS}>Clones from</span>
                <p
                  className="font-mono text-[11px] leading-4 break-all text-muted-foreground"
                  data-testid="project-setup-clone-url"
                >
                  {cloneUrl}
                </p>
              </div>
            ) : null}
            <FilesField
              files={files}
              ticked={ticked}
              truncated={source.filesTruncated}
              target={target}
              disabled={starting}
              onChange={(next) => setPickedFiles(next)}
            />
            {!filesFit ? (
              <p className="text-xs text-destructive" data-testid="project-setup-files-too-big">
                The ticked files come to more than 8 MB. Untick some to send the rest.
              </p>
            ) : null}
          </>
        ) : null}
        {startError !== null ? (
          <p
            role="alert"
            className="text-sm text-destructive"
            data-testid="project-setup-start-error"
          >
            {startError}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={closeProjectSetupDialog}>
          Cancel
        </Button>
        <Button disabled={!canStart} onClick={() => void start()} data-testid="project-setup-start">
          {starting ? "Starting…" : "Start"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

/** The computers the project can go to, when there is more than one. */
function TargetField({
  targets,
  target,
  disabled,
  onChange,
}: {
  readonly targets: ReadonlyArray<ProjectSetupTarget>;
  /** Null: none picked (the one picked dropped out). */
  readonly target: ProjectSetupTarget | null;
  readonly disabled: boolean;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className={FIELD_LABEL_CLASS}>Computer</span>
      <Select
        value={target?.environmentId ?? null}
        disabled={disabled}
        onValueChange={(value) => {
          const next = targets.find((candidate) => candidate.environmentId === value);
          if (next) onChange(next.environmentId);
        }}
      >
        <SelectTrigger className="w-full" aria-label="Computer" data-testid="project-setup-target">
          <SelectValue>{target?.label ?? "Pick a computer"}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {targets.map((candidate) => (
            <SelectItem
              key={candidate.environmentId}
              value={candidate.environmentId}
              data-testid={`project-setup-target-${candidate.environmentId}`}
            >
              {candidate.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/**
 * The ignored files that could go along: ticked ones are read from the source
 * at Start and sent with it. Off, with why, where a connection isn't protected.
 */
function FilesField({
  files,
  ticked,
  truncated,
  target,
  disabled,
  onChange,
}: {
  readonly files: ReadonlyArray<ProjectSetupFileCandidate>;
  readonly ticked: ReadonlySet<string>;
  readonly truncated: boolean;
  readonly target: ProjectSetupTarget;
  readonly disabled: boolean;
  readonly onChange: (ticked: ReadonlySet<string>) => void;
}) {
  const allowed = target.unprotected === null;
  const sendable = files.filter((file) => !file.tooLarge);
  const listDisabled = disabled || !allowed;
  return (
    <div className="grid gap-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className={FIELD_LABEL_CLASS}>Files to copy</span>
        {allowed && sendable.length > 0 ? (
          <span className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => onChange(new Set(sendable.map((file) => file.path)))}
              data-testid="project-setup-files-all"
            >
              All
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => onChange(new Set())}
              data-testid="project-setup-files-none"
            >
              None
            </Button>
          </span>
        ) : null}
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground">No ignored files to copy.</p>
      ) : (
        <div
          className="surface-group max-h-48 overflow-y-auto py-1"
          data-testid="project-setup-files"
        >
          {files.map((file) => {
            const checked = allowed && !file.tooLarge && ticked.has(file.path);
            return (
              <label
                key={file.path}
                className={cn(
                  "flex min-h-8 items-center gap-2.5 px-3 py-1",
                  listDisabled || file.tooLarge ? "cursor-default" : "cursor-pointer",
                )}
                data-testid={`project-setup-file-${file.path}`}
                data-checked={checked ? "true" : "false"}
              >
                <Checkbox
                  checked={checked}
                  disabled={listDisabled || file.tooLarge}
                  aria-label={file.path}
                  onCheckedChange={(next) => {
                    const updated = new Set(ticked);
                    if (next) updated.add(file.path);
                    else updated.delete(file.path);
                    onChange(updated);
                  }}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-mono text-[12px]",
                    listDisabled || file.tooLarge ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {file.path}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {file.tooLarge ? "Over 1 MB" : formatProjectSetupFileSize(file.size)}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {truncated ? (
        <p className="text-xs text-muted-foreground" data-testid="project-setup-files-truncated">
          Showing the first 500.
        </p>
      ) : null}
      {files.length > 0 ? (
        <p
          className="text-xs leading-[18px] text-muted-foreground"
          data-testid="project-setup-files-note"
        >
          {target.unprotected === null
            ? `Sent encrypted to ${target.label}. Nothing else leaves this computer.`
            : projectSetupFilesBlockedReason(target.unprotected.label)}
        </p>
      ) : null}
    </div>
  );
}

/** One job, as its computer tells it: how far it got, then how it ended. */
function ProjectSetupJobView({
  environmentId,
  setupId,
  onRetried,
}: {
  readonly environmentId: EnvironmentId;
  readonly setupId: ProjectSetupId;
  readonly onRetried: (setupId: ProjectSetupId) => void;
}) {
  const job = useProjectSetupJob(environmentId, setupId);
  const computerLabel = useComputerLabel();
  const label = computerLabel(environmentId, environmentId);
  const startThread = useStartThreadInSetUpProject();
  const [busy, setBusy] = useState<"cancel" | "retry" | "thread" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // While this job is on screen its end raises no toast: the dialog says it.
  useEffect(() => {
    setShownProjectSetup(setupId);
    return () => setShownProjectSetup(null);
  }, [setupId]);

  const target = { environmentId, label };
  const run = async (kind: "cancel" | "retry" | "thread", action: () => Promise<void>) => {
    setBusy(kind);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(describeProjectSetupFailure(error, `${label} didn't answer.`));
    } finally {
      setBusy(null);
    }
  };

  const title = job?.title ?? "the project";
  const finished = job !== null && isProjectSetupFinished(job.stage);
  const sourceLabel = job !== null ? computerLabel(job.source.environmentId, job.source.label) : "";
  const retryable = job !== null && canRetryProjectSetup(job);

  return (
    <DialogPopup className="max-w-lg" data-testid="project-setup-dialog">
      <DialogHeader>
        <DialogTitle>Set up {title} on another computer</DialogTitle>
      </DialogHeader>
      <DialogPanel className="space-y-3">
        {job === null ? (
          <p className="text-sm text-muted-foreground" data-testid="project-setup-job-missing">
            {label} doesn&apos;t list this setup any more.
          </p>
        ) : job.stage === "done" ? (
          <div className="space-y-2" data-testid="project-setup-done">
            <p className="text-[13.5px] leading-[19px] font-medium text-foreground">
              {job.title} is ready on {label}
            </p>
            <p className="font-mono text-[11px] leading-4 break-all text-muted-foreground">
              {job.destinationPath}
            </p>
            {job.warnings.length > 0 ? (
              <ul className="space-y-1" data-testid="project-setup-warnings">
                {job.warnings.map((warning) => (
                  <li key={warning} className="text-[12.5px] leading-[18px] text-warning">
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : job.stage === "failed" ? (
          <div className="space-y-1" data-testid="project-setup-failed">
            <p className="text-[13.5px] leading-[19px] font-medium text-foreground">
              Couldn&apos;t set up {job.title} on {label}
            </p>
            <p role="alert" className="text-sm text-destructive" data-testid="project-setup-error">
              {job.error ?? "It stopped without saying why."}
            </p>
          </div>
        ) : job.stage === "cancelled" ? (
          <p className="text-sm text-foreground" data-testid="project-setup-cancelled">
            Cancelled.
          </p>
        ) : (
          <ProjectSetupProgress job={job} label={label} />
        )}
        {finished && job.stage !== "done" && !retryable ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="project-setup-retry-unavailable"
          >
            Connect to {sourceLabel} in this app to retry.
          </p>
        ) : null}
        {actionError !== null ? (
          <p
            role="alert"
            className="text-sm text-destructive"
            data-testid="project-setup-action-error"
          >
            {actionError}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {job === null ? (
          <Button onClick={closeProjectSetupDialog}>Close</Button>
        ) : job.stage === "done" ? (
          <>
            <Button
              variant="outline"
              onClick={closeProjectSetupDialog}
              data-testid="project-setup-close"
            >
              Close
            </Button>
            <Button
              disabled={busy !== null || job.projectId === null}
              data-testid="project-setup-start-thread"
              onClick={() =>
                void run("thread", async () => {
                  if (job.projectId === null) return;
                  const started = await startThread(scopeProjectRef(environmentId, job.projectId));
                  if (!started) throw new Error(`${label} hasn't shown the new project yet.`);
                  closeProjectSetupDialog();
                })
              }
            >
              Start a thread there
            </Button>
          </>
        ) : finished ? (
          <>
            <Button
              variant="outline"
              onClick={closeProjectSetupDialog}
              data-testid="project-setup-close"
            >
              Close
            </Button>
            <Button
              disabled={busy !== null || !retryable}
              data-testid="project-setup-retry"
              onClick={() =>
                void run("retry", async () => {
                  onRetried(await retryProjectSetup(job, target));
                })
              }
            >
              {busy === "retry" ? "Retrying…" : "Retry"}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={busy !== null || !isProjectSetupCancellable(job.stage)}
              data-testid="project-setup-cancel"
              onClick={() => void run("cancel", () => cancelProjectSetup(target, job.setupId))}
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel"}
            </Button>
            <Button onClick={closeProjectSetupDialog} data-testid="project-setup-background">
              Keep going in the background
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}

/** An unfinished job's stage, git's own words for the step, and where it goes. */
export function ProjectSetupProgress({
  job,
  label,
}: {
  readonly job: ProjectSetupJob;
  readonly label: string;
}) {
  const progress = describeProjectSetupProgress(job);
  const percent = job.stage === "cloning" ? job.progress.percent : null;
  return (
    <div className="surface-group space-y-1.5 px-3.5 py-2.5" data-testid="project-setup-progress">
      <div className="flex items-baseline justify-between gap-3">
        <p
          className="text-[13.5px] leading-[19px] font-medium text-foreground"
          data-testid="project-setup-stage"
        >
          {describeProjectSetupStage(job)}
        </p>
        {job.progress.stalled ? (
          <span className="shrink-0 text-xs text-warning" data-testid="project-setup-stalled">
            Stalled
          </span>
        ) : null}
      </div>
      {percent !== null ? (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
          <div
            className="h-full rounded-full bg-primary-graph"
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      ) : null}
      {progress !== null ? (
        <p className="font-mono text-[11px] leading-4 break-all text-muted-foreground">
          {progress}
        </p>
      ) : null}
      <p className="text-[12.5px] leading-[18px] text-muted-foreground">
        Into <span className="font-mono text-[11px]">{job.destinationPath}</span> on {label}
      </p>
    </div>
  );
}
