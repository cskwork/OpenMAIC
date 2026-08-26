/* eslint-disable @typescript-eslint/no-explicit-any -- temporary sibling API declarations. */
/**
 * Compile-time contracts for the independently landed workbench data, chat,
 * and workspace-shell slices. Remove this bridge when those branches merge;
 * it intentionally contains declarations only, never fallback behavior.
 */
declare module '@/lib/workbench/session-store' {
  export interface WorkbenchMaterial {
    readonly materialId: string;
    readonly name: string;
  }
  export interface WorkbenchSessionMeta {
    readonly id: string;
    readonly courseRefsAccepted?: boolean;
  }
  export class WorkbenchApiError extends Error {
    readonly status: number;
  }
  export function createWorkbenchSession(input: {
    prompt: string;
    skill?: string;
    materials?: readonly WorkbenchMaterial[];
    courseRefs?: readonly import('@/lib/workbench/course-refs').CourseRef[];
    stageId?: string;
    existingCourse?: boolean;
  }): Promise<WorkbenchSessionMeta>;
}

declare module '@/lib/workbench/course-refs' {
  export interface CourseRef {
    readonly stageId: string;
    readonly title: string;
  }
  export function makeCourseRef(stageId: string, title: string): CourseRef | null;
  export function addCourseRef(refs: readonly CourseRef[], ref: CourseRef): CourseRef[];
  export function removeCourseRef(refs: readonly CourseRef[], stageId: string): CourseRef[];
}

declare module '@/lib/workbench/course-mention' {
  export interface CourseMentionSource {
    readonly id: string;
    readonly name: string;
    readonly updatedAt?: number;
  }
  export interface CourseMentionCandidate {
    readonly stageId: string;
    readonly title: string;
  }
  export interface CourseMention {
    readonly start: number;
    readonly end: number;
    readonly query: string;
  }
  export function orderCourseMentionCandidates(input: unknown): CourseMentionCandidate[];
  export function replaceCourseMention(
    draft: string,
    mention: CourseMention,
  ): { draft: string; caret: number };
}

declare module '@/lib/workbench/composer-image-transfer' {
  export function composerImagesFromClipboard(data: DataTransfer): File[];
  export function composerImagesFromDrop(data: DataTransfer): File[];
  export function composerTransferHasImages(data: DataTransfer): boolean;
}

declare module '@/lib/workbench/composer-keys' {
  export const COMPOSER_SEND_ARIA_KEYSHORTCUTS: string;
  export function shouldSendComposerKey(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
}

declare module '@/lib/workbench/composer-menus' {
  export function resolveComposerMenu(input: unknown): {
    menu: 'skill' | 'course' | null;
    slash: string | null;
    mention: import('@/lib/workbench/course-mention').CourseMention | null;
  };
}

declare module '@/lib/workbench/composer-skills' {
  export function skillHandleName(token: string): string | null;
  export function insertSkillHandle(
    draft: string,
    skillName: string,
    caret: number,
  ): { draft: string; caret: number };
  export function seedSlashQuery(
    draft: string,
    caret: number,
  ): { draft: string; caret: number } | null;
}

declare module '@/lib/workbench/workspace-panes' {
  export function workspaceHref(panes: {
    sessionId: string | null;
    courseId: string | null;
  }): string;
}

declare module '@/components/workbench/compose-extras' {
  import type { ComponentType } from 'react';
  export interface AgentSkillInfo {
    readonly name: string;
  }
  export const AtSignButton: ComponentType<any>;
  export const AttachButton: ComponentType<any>;
  export const MaterialChips: ComponentType<any>;
  export const SkillButton: ComponentType<any>;
  export const SkillSlashMenu: ComponentType<any>;
  export function useComposerMaterials(): {
    enabled: boolean;
    busy: boolean;
    materials: import('@/lib/workbench/session-store').WorkbenchMaterial[];
    uploading: unknown[];
    failed: unknown[];
    addFiles(files: readonly File[]): void;
    remove(id: string): void;
    removeFailed(id: string): void;
    clear(): void;
  };
}

declare module '@/components/workbench/use-skill-handle-backspace' {
  export function useSkillHandleBackspace(
    setDraft: React.Dispatch<React.SetStateAction<string>>,
    setCaret: (caret: number) => void,
  ): (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

declare module '@/components/workbench/composer-input' {
  import type { ComponentType, RefObject, TextareaHTMLAttributes } from 'react';
  export interface ComposerTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
    readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
    readonly mirrorTestId?: string;
    readonly onCaretChange: (caret: number) => void;
  }
  export const ComposerTextarea: ComponentType<ComposerTextareaProps>;
}
declare module '@/components/workbench/composer-pill' {
  import type { ComponentType } from 'react';
  export const ComposerPillRow: ComponentType<any>;
}
declare module '@/components/workbench/course-mention-menu' {
  import type { ComponentType } from 'react';
  export const CourseMentionMenu: ComponentType<{
    id: string;
    candidates: readonly import('@/lib/workbench/course-mention').CourseMentionCandidate[];
    onClose: () => void;
    onPick: (candidate: import('@/lib/workbench/course-mention').CourseMentionCandidate) => void;
  }>;
}
declare module '@/components/workbench/course-ref-pills' {
  import type { ComponentType } from 'react';
  export const CourseRefPills: ComponentType<{
    inline?: boolean;
    refs: readonly import('@/lib/workbench/course-refs').CourseRef[];
    onRemove: (stageId: string) => void;
  }>;
}
declare module '@/components/workbench/workspace/WorkspaceShell' {
  import type { ComponentType } from 'react';
  export const WorkspaceShell: ComponentType;
}
