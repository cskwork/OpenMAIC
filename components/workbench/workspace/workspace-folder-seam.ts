/**
 * Optional folder integration for the workspace rail.
 *
 * The upstream base used by this slice has no folder routes. Keeping the
 * adapter nullable lets the rail render its authoritative flat course list
 * without issuing speculative requests. A folder slice can install the real
 * adapter at this single boundary when those routes are present.
 */
export interface WorkspaceFolderAdapter {
  readonly create: (name: string) => Promise<void>;
  readonly rename: (folderId: string, name: string) => Promise<void>;
  readonly removeKeepingCourses: (folderId: string) => Promise<void>;
}

export class WorkspaceFolderNameError extends Error {
  constructor(
    readonly kind: 'duplicate' | 'tooLong' | 'empty' | 'invalid' | 'limit',
    message = kind,
  ) {
    super(message);
    this.name = 'WorkspaceFolderNameError';
  }
}

/** Null on this base: the rail deliberately falls back to an ungrouped list. */
export const workspaceFolderAdapter: WorkspaceFolderAdapter | null = null;

export const workspaceFoldersAvailable = (): boolean => workspaceFolderAdapter !== null;
