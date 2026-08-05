/**
 * Read-only video-export support for PBL v1 scenes stored before the v2 cutover.
 *
 * This module is kept indefinitely so historical scenes remain exportable.
 * Writers must never import it to create or project legacy PBL shapes.
 */
type UnknownRecord = Record<string, unknown>;

interface LegacyPblCover {
  kind: 'pbl-cover';
  startMs: number;
  durationMs: number;
  title: string;
  description: string;
  gains: string[];
  stageCount: number;
  taskCount: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function legacyIssueRoot(
  issue: UnknownRecord,
  issueById: ReadonlyMap<unknown, UnknownRecord>,
): UnknownRecord | undefined {
  let current = issue;
  const visited = new Set<UnknownRecord>();

  while (current.parent_issue !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const parent = issueById.get(current.parent_issue);
    if (!parent) return undefined;
    current = parent;
  }

  return current;
}

function legacyStageCount(issues: readonly UnknownRecord[]): number {
  const issueById = new Map<unknown, UnknownRecord>();
  for (const issue of issues) issueById.set(issue.id, issue);

  const roots = new Set<UnknownRecord>();
  let standaloneCount = 0;
  for (const issue of issues) {
    const root = legacyIssueRoot(issue, issueById);
    if (root) roots.add(root);
    else standaloneCount += 1;
  }
  return roots.size + standaloneCount;
}

export function pblLegacyCover(
  project: unknown,
  scene: { title: string },
  timeline: { startMs: number; durationMs: number },
): LegacyPblCover {
  const legacyProject = isRecord(project) ? project : {};
  const projectInfo = isRecord(legacyProject.projectInfo) ? legacyProject.projectInfo : {};
  const issueboard = isRecord(legacyProject.issueboard) ? legacyProject.issueboard : {};
  const issues = records(issueboard.issues);
  return {
    kind: 'pbl-cover',
    startMs: timeline.startMs,
    durationMs: timeline.durationMs,
    title: text(projectInfo.title) ?? scene.title,
    description: text(projectInfo.description) ?? '',
    gains: [],
    stageCount: legacyStageCount(issues),
    taskCount: issues.length,
  };
}
