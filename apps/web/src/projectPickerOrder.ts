/**
 * How the project pickers order projects. Pinned projects (folders in
 * `UiProjectState.pinnedProjectCwds`) come first; a project with checkouts in
 * several folders counts as pinned when any of them is.
 */

/** Whether a project, by its checkouts' folders, is pinned. */
export function isProjectPinned(
  cwds: readonly string[],
  pinnedProjectCwds: readonly string[],
): boolean {
  return cwds.some((cwd) => pinnedProjectCwds.includes(cwd));
}

/** Pinned projects first, each part keeping the order it came in. */
export function pinnedProjectsFirst<T extends { readonly cwd: string }>(
  projects: readonly T[],
  pinnedProjectCwds: readonly string[],
): T[] {
  if (pinnedProjectCwds.length === 0) return [...projects];
  const pinned = new Set(pinnedProjectCwds);
  return [
    ...projects.filter((project) => pinned.has(project.cwd)),
    ...projects.filter((project) => !pinned.has(project.cwd)),
  ];
}

/**
 * Moves `peers[from]` to `peers[to]` and returns the whole list with the peers
 * rearranged in the slots they already held: every row that isn't a peer (one
 * a search hid, or one in the other group) keeps its place.
 */
export function moveAmongPeers<T>(
  all: readonly T[],
  peers: readonly T[],
  from: number,
  to: number,
): T[] {
  const moved = [...peers];
  const [item] = moved.splice(from, 1);
  if (item === undefined) return [...all];
  moved.splice(to, 0, item);
  const peerSet = new Set(peers);
  let next = 0;
  return all.map((row) => (peerSet.has(row) ? moved[next++]! : row));
}
