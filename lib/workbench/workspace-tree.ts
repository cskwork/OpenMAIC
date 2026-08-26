/**
 * Pure projections behind the Pro workspace's navigation tree.
 *
 * Same rule as `pro-home-data`: data shaping only — no fetching, no React — so
 * the grouping, the filter and the truncation can be tested without a browser.
 *
 * The folder rules here deliberately mirror `DiscoveryAreaLive`'s, because the
 * tree and the course grid read the SAME list and must not disagree about
 * where a course lives:
 *
 *  - a course whose `folderId` names a folder that is not in the folder list is
 *    unfiled, not lost (the grid applies the identical `!folderNameById.has()`
 *    guard) — a deleted folder must not take its courses off the screen;
 *  - searching flattens the hierarchy: every match is shown regardless of
 *    folder, annotated with its folder name, exactly as the grid does.
 */

/** The subset of `StageListItem` the tree actually reads. */
export interface WorkspaceCourseLike {
  readonly id: string;
  readonly name?: string;
  readonly folderId?: string;
  /** `false` = saved from Discover; `true`/absent = the user's own. */
  readonly isOwner?: boolean;
}

export interface WorkspaceFolderLike {
  readonly id: string;
  readonly name: string;
}

export interface WorkspaceFolderGroup<C> {
  readonly folder: WorkspaceFolderLike;
  readonly courses: readonly C[];
}

export interface WorkspaceCourseTree<C> {
  /** Folders in the folder list's own order, each with its members. */
  readonly groups: readonly WorkspaceFolderGroup<C>[];
  /** Courses with no folder, or whose folder no longer exists. */
  readonly ungrouped: readonly C[];
}

/**
 * Case-insensitive substring match. An empty/whitespace query matches
 * everything, so a section with the search box open but empty still lists.
 */
export function matchesQuery(value: string | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (value ?? '').toLowerCase().includes(q);
}

/**
 * Filter by display name. Returns the ORIGINAL array reference for an empty
 * query so callers memoising on identity do not re-render for a no-op filter.
 */
export function filterByName<T extends { readonly name?: string }>(
  items: readonly T[],
  query: string,
): readonly T[] {
  if (!query.trim()) return items;
  return items.filter((item) => matchesQuery(item.name, query));
}

/** Group courses under their folders, with the unfiled remainder alongside. */
export function groupCoursesByFolder<C extends WorkspaceCourseLike>(
  courses: readonly C[],
  folders: readonly WorkspaceFolderLike[],
): WorkspaceCourseTree<C> {
  const known = new Set(folders.map((folder) => folder.id));
  const byFolder = new Map<string, C[]>();
  const ungrouped: C[] = [];

  for (const course of courses) {
    // An unknown folder id means the folder was deleted underneath the course:
    // treat it as unfiled rather than dropping the course from the tree.
    if (course.folderId !== undefined && known.has(course.folderId)) {
      const bucket = byFolder.get(course.folderId);
      if (bucket) bucket.push(course);
      else byFolder.set(course.folderId, [course]);
    } else {
      ungrouped.push(course);
    }
  }

  return {
    groups: folders.map((folder) => ({ folder, courses: byFolder.get(folder.id) ?? [] })),
    ungrouped,
  };
}

export interface OwnershipSplit<C> {
  /** Courses the user authored — the ones manage actions may be offered on. */
  readonly owned: readonly C[];
  /** Courses saved from Discover. Not editable by this user. */
  readonly favorites: readonly C[];
}

/**
 * Split "my courses" into authored and saved.
 *
 * Live mode serves BOTH through one bookmark-driven list, so only an explicit
 * `isOwner === false` marks a favorite. An absent flag (self-deploy, or a
 * server that has not been taught the field) counts as owned: withdrawing
 * rename/move because a signal is missing would be a regression, while
 * offering them on a favorite merely reproduces today's behaviour.
 */
export function partitionByOwnership<C extends WorkspaceCourseLike>(
  courses: readonly C[],
): OwnershipSplit<C> {
  const owned: C[] = [];
  const favorites: C[] = [];
  for (const course of courses) {
    if (course.isOwner === false) favorites.push(course);
    else owned.push(course);
  }
  return { owned, favorites };
}
