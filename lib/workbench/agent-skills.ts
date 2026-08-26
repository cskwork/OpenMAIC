'use client';

/**
 * The shared installed-skill registry: the fetch, its cache, `useAgentSkills`
 * and the display-name helpers. The chat timeline names a loaded skill with
 * `skillLabelForId`, the composer's `/` menu and the skill button read the same
 * snapshot.
 *
 * NOTE (chat slice): ported as-is so the chat surface and its tests can run;
 * the sibling data-layer slice owns this module and supersedes this copy.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  defaultWorkbenchTranslator,
  type WorkbenchCopyKey,
  type WorkbenchTranslator,
} from '@/lib/i18n/workbench';

export interface AgentSkillInfo {
  /** Stable internal id submitted to APIs (usk_* for a user Skill). */
  id: string;
  /** Readable slash handle. */
  name: string;
  /** The locale-specific display name from the skill's frontmatter, when present. */
  title?: string;
  description: string;
  hasConstraints: boolean;
  source: 'builtin' | 'user';
}

interface RegistrySnapshot {
  skills: AgentSkillInfo[];
  loading: boolean;
  /**
   * Why the list is missing, as a COPY KEY rather than a sentence.
   */
  error: WorkbenchCopyKey | null;
}

/** The registry's failure, in the reader's language. */
export function agentSkillsErrorText(
  snapshot: Pick<RegistrySnapshot, 'error'>,
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string | null {
  return snapshot.error ? t(snapshot.error) : null;
}

/**
 * A failed `GET /api/agent/skills`: a copy key for the UI, and a developer
 * sentence (with the status, which no UI shows) for the console.
 */
class AgentSkillsError extends Error {
  readonly copyKey: WorkbenchCopyKey;

  constructor(copyKey: WorkbenchCopyKey, cause?: string) {
    super(cause ? `agent skills request failed: ${cause}` : 'agent skills request failed');
    this.copyKey = copyKey;
  }
}

let snapshot: RegistrySnapshot = { skills: [], loading: true, error: null };
let skillsCache: AgentSkillInfo[] | null = null;
let skillsRequest: Promise<AgentSkillInfo[]> | null = null;
let invalidationRequest: Promise<AgentSkillInfo[]> | null = null;
let ownerEpoch = 0;
const listeners = new Set<() => void>();

function publish(next: RegistrySnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function loadAgentSkills(force = false): Promise<AgentSkillInfo[]> {
  if (force) skillsCache = null;
  if (skillsCache) return Promise.resolve(skillsCache);
  if (skillsRequest) return skillsRequest;
  const requestEpoch = ownerEpoch;
  publish({ ...snapshot, loading: true, error: null });
  skillsRequest = fetch('/api/agent/skills')
    .then(async (res) => {
      if (!res.ok) throw new AgentSkillsError('workbench.skill.listFailed', String(res.status));
      return (await res.json()) as AgentSkillInfo[];
    })
    .then((list) => {
      if (requestEpoch !== ownerEpoch) return list;
      skillsCache = list;
      publish({ skills: list, loading: false, error: null });
      return list;
    })
    .catch((error: unknown) => {
      if (requestEpoch !== ownerEpoch) throw error;
      const copyKey =
        error instanceof AgentSkillsError ? error.copyKey : 'workbench.skill.listFailed';
      publish({ skills: snapshot.skills, loading: false, error: copyKey });
      throw error;
    })
    .finally(() => {
      skillsRequest = null;
    });
  return skillsRequest;
}

/** Invalidate every consumer and perform one shared registry refresh. */
export function invalidateAgentSkills(): Promise<AgentSkillInfo[]> {
  if (invalidationRequest) return invalidationRequest;
  const pending = skillsRequest;
  invalidationRequest = (pending ? pending.catch(() => []) : Promise.resolve([]))
    .then(() => loadAgentSkills(true))
    .finally(() => {
      invalidationRequest = null;
    });
  return invalidationRequest;
}

/** Clear owner-scoped metadata immediately, then fetch for the new identity. */
export function refreshAgentSkillsForOwnerChange(): Promise<AgentSkillInfo[]> {
  ownerEpoch += 1;
  skillsCache = null;
  publish({ skills: [], loading: true, error: null });
  const pending = [skillsRequest, invalidationRequest].filter(
    (request): request is Promise<AgentSkillInfo[]> => request !== null,
  );
  return Promise.allSettled(pending).then(() => loadAgentSkills(true));
}

export function useAgentSkills(): RegistrySnapshot & { reload: () => Promise<void> } {
  const [, render] = useState(0);
  useEffect(() => {
    const listener = () => render((value) => value + 1);
    const onAuthChange = () => {
      void refreshAgentSkillsForOwnerChange().catch(() => {});
    };
    listeners.add(listener);
    window.addEventListener('auth-change', onAuthChange);
    if (skillsCache === null && !skillsRequest) void loadAgentSkills().catch(() => {});
    return () => {
      listeners.delete(listener);
      window.removeEventListener('auth-change', onAuthChange);
    };
  }, []);
  const reload = useCallback(async () => {
    await invalidateAgentSkills();
  }, []);
  return { ...snapshot, reload };
}

/**
 * A built-in skill's display name in the reader's language.
 */
export function skillTitle(
  skill: { readonly name: string; readonly title?: string | null; readonly source?: string },
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string | undefined {
  if (skill.source !== 'user') {
    const key: WorkbenchCopyKey = `workbench.skill.title.${skill.name}`;
    const localized = t(key);
    if (localized !== key) return localized;
  }
  return skill.title?.trim() || undefined;
}

/**
 * One line naming a skill: `<title> /<id>`.
 */
export function skillDisplayLabel(
  skill: {
    readonly name: string;
    readonly title?: string | null;
    readonly source?: string;
  },
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string {
  const title = skillTitle(skill, t);
  return title ? `${title} /${skill.name}` : `/${skill.name}`;
}

export function skillLabelForId(
  id: string,
  skills: readonly AgentSkillInfo[],
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string {
  const known = skills.find((skill) => skill.id === id || skill.name === id);
  return known ? skillDisplayLabel(known, t) : skillDisplayLabel({ name: id }, t);
}
