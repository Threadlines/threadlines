import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@threadlines/contracts";
import { areFilesystemPathsEqual, shortenHomePath } from "@threadlines/shared/path";
import { threadWorkingCwdLabel } from "@threadlines/shared/threadCwd";
import { memo, useCallback, useEffect, useMemo } from "react";
import { ChevronDownIcon, CopyIcon, FolderGit2Icon } from "lucide-react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { copyWithNotice } from "../ui/copyWithNotice";
import {
  EditorOpenRadioGroup,
  editorOpenActionLabel,
  useEditorOpenOptions,
} from "../EditorOpenOptions";
import { ProjectFavicon } from "../ProjectFavicon";
import { readLocalApi } from "~/localApi";

/**
 * The project crumb in the chat header, and everything that acts on the
 * folder the thread works in: open it in an installed editor or reveal it in
 * the file manager, copy its path, and pick the default editor the
 * open-favorite shortcut launches. A thread working in a worktree names that
 * worktree at the top, and offers the same actions for the project's own
 * folder one level down under "Main project". Owns the shortcut, which always
 * opens the thread's folder, so it stays mounted wherever a crumb could be,
 * including the phone layout that hides the crumb itself.
 */
export const ProjectCrumbMenu = memo(function ProjectCrumbMenu({
  projectName,
  environmentId,
  projectCwd,
  cwd,
  checkoutBranch,
  canOpenInEditor,
  keybindings,
  availableEditors,
}: {
  projectName: string;
  environmentId: EnvironmentId;
  /** The project's own folder, which its icon is read from. Not the worktree:
   *  the sidebar asks by this folder too, so the two always show the same icon. */
  projectCwd: string;
  /** The folder the thread works in: its worktree when it has one. */
  cwd: string;
  /** The branch checked out in `cwd`, which names a worktree in the menu. */
  checkoutBranch: string | null;
  /** Editors run on the machine hosting the server, so only the primary
   *  environment can launch them; elsewhere the menu only copies the path. */
  canOpenInEditor: boolean;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useEditorOpenOptions(availableEditors);
  const openFavoriteShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  const inWorktree = !areFilesystemPathsEqual(cwd, projectCwd);
  const offersDefaultEditor = canOpenInEditor && options.length > 0;

  const openIn = useCallback((path: string, editor: EditorId) => {
    const api = readLocalApi();
    if (!api) return;
    void api.shell.openInEditor(path, editor);
  }, []);

  useEffect(() => {
    if (!canOpenInEditor) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!preferredEditor || !readLocalApi()) return;
      event.preventDefault();
      openIn(cwd, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canOpenInEditor, cwd, keybindings, openIn, preferredEditor]);

  /** Every editor, then Copy path, aimed at `path`. Only the thread's own
   *  folder shows the shortcut, since that is the one it opens. */
  const folderItems = (path: string, shortcutLabel: string | null) => (
    <>
      {canOpenInEditor ? (
        options.length === 0 ? (
          <MenuItem disabled>No installed editors found</MenuItem>
        ) : (
          options.map((option) => (
            <MenuItem key={option.value} onClick={() => openIn(path, option.value)}>
              <option.Icon aria-hidden="true" className="text-muted-foreground" />
              {editorOpenActionLabel(option)}
              {option.value === preferredEditor && shortcutLabel ? (
                <MenuShortcut>{shortcutLabel}</MenuShortcut>
              ) : null}
            </MenuItem>
          ))
        )
      ) : null}
      <MenuItem onClick={() => void copyWithNotice(path, "path")}>
        <CopyIcon aria-hidden="true" className="text-muted-foreground" />
        Copy path
      </MenuItem>
    </>
  );

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="-ms-1 inline-flex min-w-0 max-w-48 items-center gap-0.5 rounded-md px-1 py-0.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
            aria-label={`${projectName}, project options`}
            title={projectName}
          />
        }
      >
        <ProjectFavicon
          environmentId={environmentId}
          cwd={projectCwd}
          name={projectName}
          className="me-1"
        />
        <span className="truncate">{projectName}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        {inWorktree ? (
          <MenuGroup>
            <MenuGroupLabel className="flex min-w-0 items-center gap-1.5">
              <FolderGit2Icon aria-hidden="true" className="size-3.5 shrink-0" />
              Worktree{" "}
              <span className="min-w-0 truncate font-mono font-normal">
                {checkoutBranch ?? threadWorkingCwdLabel(cwd)}
              </span>
            </MenuGroupLabel>
            {folderItems(cwd, openFavoriteShortcutLabel)}
          </MenuGroup>
        ) : (
          folderItems(cwd, openFavoriteShortcutLabel)
        )}
        {inWorktree || offersDefaultEditor ? <MenuSeparator /> : null}
        {inWorktree ? (
          <MenuSub>
            <MenuSubTrigger>Main project</MenuSubTrigger>
            <MenuSubPopup className="min-w-52">
              <MenuGroup>
                <MenuGroupLabel
                  className="max-w-72 truncate font-mono font-normal"
                  title={projectCwd}
                >
                  {shortenHomePath(projectCwd)}
                </MenuGroupLabel>
                {folderItems(projectCwd, null)}
              </MenuGroup>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        {offersDefaultEditor ? (
          <>
            {/* Picking here only changes what the shortcut opens; it launches
                nothing. */}
            <MenuSub>
              <MenuSubTrigger>
                {openFavoriteShortcutLabel
                  ? `Default for ${openFavoriteShortcutLabel}`
                  : "Default editor"}
              </MenuSubTrigger>
              <MenuSubPopup>
                <EditorOpenRadioGroup
                  options={options}
                  preferredEditor={preferredEditor}
                  onSelect={setPreferredEditor}
                />
              </MenuSubPopup>
            </MenuSub>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
