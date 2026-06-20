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
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { deriveSettingsProjectOptions } from "./settingsProjectOptions";

function instructionProviderLabel(kind: ProviderInstructionFileKind): string {
  switch (kind) {
    case "codex-agents":
      return "Codex";
    case "claude-instructions":
      return "Claude";
  }
}

function InstructionEditor({
  cwd,
  file,
  onSaved,
}: {
  cwd: string;
  file: ProviderInstructionFile;
  onSaved: (file: ProviderInstructionFile) => void;
}) {
  const [contents, setContents] = useState(file.contents ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const dirty = contents !== (file.contents ?? "");
  const provider = instructionProviderLabel(file.kind);

  useEffect(() => {
    setContents(file.contents ?? "");
  }, [file.contents, file.path]);

  const save = useCallback(async () => {
    if (!file.editable || !file.relativePath) return;
    setIsSaving(true);
    try {
      const result = await ensureLocalApi().server.writeProviderInstructionFile({
        cwd,
        kind: file.kind,
        contents,
      });
      onSaved(result.file);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Instruction file saved",
          description: result.file.relativePath ?? result.file.path,
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save instruction file",
          description: error instanceof Error ? error.message : "Save failed.",
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }, [contents, cwd, file, onSaved]);

  return (
    <SettingsRow
      title={`${provider} - ${file.relativePath ?? file.path}`}
      description={file.path}
      status={
        file.editable
          ? file.exists
            ? `Existing ${provider} project instruction file.`
            : `This ${provider} instruction file will be created when saved.`
          : "This path is not editable from settings."
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!dirty || isSaving || !file.editable}
          onClick={save}
        >
          {isSaving ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <SaveIcon className="size-3.5" />
          )}
          Save
        </Button>
      }
    >
      {file.editable ? (
        <div className="mt-3 border-t border-border/50 py-3">
          <Textarea
            value={contents}
            onChange={(event) => setContents(event.currentTarget.value)}
            className="min-h-64 font-mono text-xs"
            rows={14}
            spellCheck={false}
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function AgentInstructionsSettingsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const projectOptions = useMemo(() => deriveSettingsProjectOptions(projects), [projects]);
  const [cwd, setCwd] = useState(() => projectOptions[0]?.value ?? "");
  const [instructions, setInstructions] = useState<ProviderInstructionFilesResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);

  useEffect(() => {
    if (!cwd && projectOptions[0]?.value) {
      setCwd(projectOptions[0].value);
    }
  }, [cwd, projectOptions]);

  const refresh = useCallback(async () => {
    const requestCwd = cwd.trim();
    if (!requestCwd) {
      setInstructions(null);
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

  const updateInstructionFile = useCallback((nextFile: ProviderInstructionFile) => {
    setInstructions((current) =>
      current
        ? {
            ...current,
            instructionFiles: current.instructionFiles.map((file) =>
              file.kind === nextFile.kind && file.relativePath === nextFile.relativePath
                ? nextFile
                : file,
            ),
          }
        : current,
    );
  }, []);

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
                  if (value) setCwd(value);
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

      <SettingsSection title="Files" icon={<FileTextIcon className="size-3.5" />}>
        {instructions?.instructionFiles.length ? (
          instructions.instructionFiles.map((file) => (
            <InstructionEditor
              key={`${file.kind}:${file.path}`}
              cwd={instructions.cwd}
              file={file}
              onSaved={updateInstructionFile}
            />
          ))
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
