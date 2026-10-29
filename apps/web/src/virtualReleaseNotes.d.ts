/** The reviewed stable release notes, newest first (apps/web/releaseNotesPlugin.ts). */
declare module "virtual:release-notes" {
  const entries: ReadonlyArray<import("@threadlines/shared/releaseNotes").ReleaseNotesEntry>;
  export default entries;
}
