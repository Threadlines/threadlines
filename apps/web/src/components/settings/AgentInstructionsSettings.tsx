import { FileTextIcon, LoaderIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import type {
  ProviderInstructionFile,
  ProviderInstructionFilesResult,
  ProviderInstructionFileKind,
} from "@threadlines/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ensureLocalApi } from "../../localApi";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { deriveSettingsProjectOptions } from "./settingsProjectOptions";

interface InstructionDraft {
  readonly contents: string;
  readonly savedContents: string;
}

function instructionProviderLabel(kind: ProviderInstructionFileKind): string {
  switch (kind) {
    case "codex-agents":
      return "Codex";
    case "claude-instructions":
      return "Claude";
  }
}

function instructionFileKey(file: ProviderInstructionFile): string {
  return `${file.kind}:${file.relativePath ?? file.path}`;
}

function instructionFileLabel(file: ProviderInstructionFile): string {
  return file.relativePath ?? file.path;
}

function instructionFileStatus(file: ProviderInstructionFile, dirty: boolean) {
  if (dirty) {
    return { label: "Edited", variant: "warning" as const };
  }
  if (!file.editable) {
    return { label: "Read-only", variant: "outline" as const };
  }
  if (file.exists) {
    return { label: "Existing", variant: "success" as const };
  }
  return { label: "Missing", variant: "outline" as const };
}

function instructionFileDescription(file: ProviderInstructionFile): string {
  const provider = instructionProviderLabel(file.kind);
  if (!file.editable) {
    return "This path is not editable from settings.";
  }
  return file.exists
    ? `Existing ${provider} project instruction file.`
    : `This ${provider} instruction file will be created when saved.`;
}

function InstructionFileButton({
  file,
  active,
  dirty,
  onSelect,
}: {
  file: ProviderInstructionFile;
  active: boolean;
  dirty: boolean;
  onSelect: () => void;
}) {
  const provider = instructionProviderLabel(file.kind);
  const status = instructionFileStatus(file, dirty);

  return (
    <button
      type="button"
      className={cn(
        "flex min-w-52 shrink-0 flex-col gap-1.5 rounded-md px-3 py-2 text-left transition-colors md:min-w-56 lg:min-w-0",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-[13px] font-medium">{instructionFileLabel(file)}</span>
        {dirty ? (
          <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Unsaved edits" />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        <Badge variant="outline" size="sm">
          {provider}
        </Badge>
        <Badge variant={status.variant} size="sm">
          {status.label}
        </Badge>
      </span>
      <span className="truncate text-[11px] text-muted-foreground/70" title={file.path}>
        {file.path}
      </span>
    </button>
  );
}

function InstructionFileEditor({
  cwd,
  file,
  draft,
  saving,
  onChange,
  onSave,
}: {
  cwd: string;
  file: ProviderInstructionFile;
  draft: InstructionDraft;
  saving: boolean;
  onChange: (contents: string) => void;
  onSave: () => void;
}) {
  const dirty = draft.contents !== draft.savedContents;
  const provider = instructionProviderLabel(file.kind);
  const status = instructionFileStatus(file, dirty);
  const title = instructionFileLabel(file);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[13px] font-semibold text-foreground">{title}</h3>
            <Badge variant="outline" size="sm">
              {provider}
            </Badge>
            <Badge variant={status.variant} size="sm">
              {status.label}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground/80" title={file.path}>
            {file.path}
          </p>
          <p className="text-[11px] text-muted-foreground">{instructionFileDescription(file)}</p>
        </div>
        <Button
          size="xs"
          variant="outline"
          className="w-full shrink-0 sm:w-auto"
          disabled={!dirty || saving || !file.editable}
          onClick={onSave}
        >
          {saving ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <SaveIcon className="size-3.5" />
          )}
          Save
        </Button>
      </div>

      {file.editable ? (
        <div className="flex min-h-0 flex-1 p-3 sm:p-4">
          <textarea
            value={draft.contents}
            onChange={(event) => onChange(event.currentTarget.value)}
            className="h-full min-h-0 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground shadow-xs/5 outline-none ring-ring/24 transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] dark:bg-input/32"
            spellCheck={false}
            aria-label={`${provider} instruction file contents`}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-12 text-center text-sm text-muted-foreground">
          {cwd
            ? "This instruction file is outside the editable project scope."
            : "No project selected."}
        </div>
      )}
    </div>
  );
}

export function AgentInstructionsSettingsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const projectOptions = useMemo(() => deriveSettingsProjectOptions(projects), [projects]);
  const [cwd, setCwd] = useState(() => projectOptions[0]?.value ?? "");
  const [instructions, setInstructions] = useState<ProviderInstructionFilesResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFileKey, setActiveFileKey] = useState<string | null>(null);
  const [instructionDrafts, setInstructionDrafts] = useState<Record<string, InstructionDraft>>({});
  const [savingFileKey, setSavingFileKey] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);
  const instructionFiles = useMemo(() => instructions?.instructionFiles ?? [], [instructions]);
  const activeFile = useMemo(() => {
    if (!activeFileKey) return instructionFiles[0] ?? null;
    return instructionFiles.find((file) => instructionFileKey(file) === activeFileKey) ?? null;
  }, [activeFileKey, instructionFiles]);
  const activeDraft = activeFile
    ? (instructionDrafts[instructionFileKey(activeFile)] ?? {
        contents: activeFile.contents ?? "",
        savedContents: activeFile.contents ?? "",
      })
    : null;
  const dirtyFileKeys = useMemo(
    () =>
      new Set(
        Object.entries(instructionDrafts)
          .filter(([, draft]) => draft.contents !== draft.savedContents)
          .map(([key]) => key),
      ),
    [instructionDrafts],
  );

  useEffect(() => {
    if (!cwd && projectOptions[0]?.value) {
      setCwd(projectOptions[0].value);
    }
  }, [cwd, projectOptions]);

  const refresh = useCallback(async () => {
    const requestCwd = cwd.trim();
    if (!requestCwd) {
      setInstructions(null);
      setInstructionDrafts({});
      setActiveFileKey(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    setIsLoading(true);
    setError(null);
    try {
      const result = await ensureLocalApi().server.getProviderInstructionFiles({ cwd: requestCwd });
      if (refreshRequestRef.current === requestId) {
        setInstructions(result);
      }
    } catch (refreshError) {
      if (refreshRequestRef.current === requestId) {
        setError(refreshError instanceof Error ? refreshError.message : "Instruction load failed.");
      }
    } finally {
      if (refreshRequestRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setActiveFileKey((current) => {
      if (instructionFiles.length === 0) return null;
      if (current && instructionFiles.some((file) => instructionFileKey(file) === current)) {
        return current;
      }
      return instructionFileKey(instructionFiles[0]!);
    });

    setInstructionDrafts((current) => {
      const next: Record<string, InstructionDraft> = {};
      let changed = Object.keys(current).length !== instructionFiles.length;

      for (const file of instructionFiles) {
        const key = instructionFileKey(file);
        const savedContents = file.contents ?? "";
        const currentDraft = current[key];
        if (currentDraft && currentDraft.contents !== currentDraft.savedContents) {
          next[key] = {
            contents: currentDraft.contents,
            savedContents,
          };
        } else {
          next[key] = {
            contents: savedContents,
            savedContents,
          };
        }

        const previous = current[key];
        if (
          !previous ||
          previous.contents !== next[key]!.contents ||
          previous.savedContents !== next[key]!.savedContents
        ) {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [instructionFiles]);

  const updateInstructionFile = useCallback((nextFile: ProviderInstructionFile) => {
    setInstructions((current) =>
      current
        ? {
            ...current,
            instructionFiles: current.instructionFiles.map((file) =>
              instructionFileKey(file) === instructionFileKey(nextFile) ? nextFile : file,
            ),
          }
        : current,
    );
  }, []);

  const updateActiveFileContents = useCallback(
    (contents: string) => {
      if (!activeFile) return;
      const key = instructionFileKey(activeFile);
      setInstructionDrafts((current) => {
        const previous = current[key] ?? {
          contents: activeFile.contents ?? "",
          savedContents: activeFile.contents ?? "",
        };
        return {
          ...current,
          [key]: {
            ...previous,
            contents,
          },
        };
      });
    },
    [activeFile],
  );

  const saveInstructionFile = useCallback(
    async (file: ProviderInstructionFile) => {
      if (!file.editable) return;
      const key = instructionFileKey(file);
      const draft = instructionDrafts[key];
      const contents = draft?.contents ?? file.contents ?? "";
      setSavingFileKey(key);
      try {
        const result = await ensureLocalApi().server.writeProviderInstructionFile({
          cwd: instructions?.cwd ?? cwd,
          kind: file.kind,
          contents,
        });
        const resultKey = instructionFileKey(result.file);
        const savedContents = result.file.contents ?? contents;
        setInstructionDrafts((current) => {
          const next = { ...current };
          if (resultKey !== key) {
            delete next[key];
          }
          next[resultKey] = {
            contents: savedContents,
            savedContents,
          };
          return next;
        });
        updateInstructionFile(result.file);
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Instruction file saved",
            description: result.file.relativePath ?? result.file.path,
          }),
        );
      } catch (saveError) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save instruction file",
            description: saveError instanceof Error ? saveError.message : "Save failed.",
          }),
        );
      } finally {
        setSavingFileKey((current) => (current === key ? null : current));
      }
    },
    [cwd, instructionDrafts, instructions?.cwd, updateInstructionFile],
  );

  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection
        title="Agent Instructions"
        icon={<FileTextIcon className="size-3.5" />}
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={isLoading}
                  onClick={() => void refresh()}
                  aria-label="Refresh instruction files"
                >
                  {isLoading ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh instruction files</TooltipPopup>
          </Tooltip>
        }
      >
        <SettingsRow
          title="Project"
          description={
            instructions?.generatedAt
              ? `Files loaded ${new Date(instructions.generatedAt).toLocaleString()}.`
              : "Pick the project whose agent instruction files you want to edit."
          }
          status={error}
          control={
            projectOptions.length > 0 ? (
              <Select
                value={cwd}
                onValueChange={(value) => {
                  if (!value) return;
                  setCwd(value);
                  setInstructions(null);
                  setInstructionDrafts({});
                  setActiveFileKey(null);
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Project">
                  <SelectValue>
                    {projectOptions.find((project) => project.value === cwd)?.label ?? "Project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {projectOptions.map((project) => (
                    <SelectItem key={project.value} hideIndicator value={project.value}>
                      {project.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Instruction Files"
        icon={<FileTextIcon className="size-3.5" />}
        headerAction={
          instructionFiles.length > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              {dirtyFileKeys.size > 0
                ? `${dirtyFileKeys.size} unsaved`
                : `${instructionFiles.length} files`}
            </span>
          ) : null
        }
      >
        {instructionFiles.length > 0 ? (
          <div className="grid h-[min(42rem,calc(100dvh-16rem))] min-h-120 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-1">
            <div className="min-w-0 border-b border-border/60 bg-muted/10 lg:border-b-0 lg:border-r">
              <div className="flex gap-1 overflow-x-auto p-2 lg:h-full lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto">
                {instructionFiles.map((file) => {
                  const key = instructionFileKey(file);
                  return (
                    <InstructionFileButton
                      key={key}
                      file={file}
                      active={activeFile ? instructionFileKey(activeFile) === key : false}
                      dirty={dirtyFileKeys.has(key)}
                      onSelect={() => setActiveFileKey(key)}
                    />
                  );
                })}
              </div>
            </div>

            <div className="flex min-h-0 min-w-0">
              {activeFile && activeDraft ? (
                <InstructionFileEditor
                  cwd={instructions?.cwd ?? cwd}
                  file={activeFile}
                  draft={activeDraft}
                  saving={savingFileKey === instructionFileKey(activeFile)}
                  onChange={updateActiveFileContents}
                  onSave={() => void saveInstructionFile(activeFile)}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center px-4 py-12 text-center text-sm text-muted-foreground">
                  Select an instruction file.
                </div>
              )}
            </div>
          </div>
        ) : (
          <SettingsRow
            title={!cwd ? "No project selected" : isLoading ? "Loading files" : "No files"}
            description={
              !cwd
                ? "Choose a project to inspect AGENTS.md and CLAUDE.md."
                : isLoading
                  ? "Reading project instruction files."
                  : "AGENTS.md and CLAUDE.md will appear here when a project is selected."
            }
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
