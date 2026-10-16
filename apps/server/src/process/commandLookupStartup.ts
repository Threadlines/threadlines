/**
 * Imported first by `bin.ts`, so it runs before any other module loads when
 * the server starts from source (the published build calls it from
 * `launcher.ts`, before loading the server): a project's own `git.exe` must
 * never stand in for git, and the server has to see the user's environment as
 * it was. The Claude SDK sets the same variable while it loads
 * (@threadlines/shared/windowsCommandLookup).
 */
import { stopWorkingFolderCommandLookup } from "@threadlines/shared/windowsCommandLookup";

stopWorkingFolderCommandLookup();
