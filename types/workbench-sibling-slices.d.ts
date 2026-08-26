/* eslint-disable @typescript-eslint/no-explicit-any -- temporary sibling API declarations. */
/**
 * Compile-time bridge for modules that ship with sibling slices (the chat
 * surface, the entry/home slice, live-only server APIs) and are NOT part of the
 * data layer that landed via integration/agent-workbench (#1204).
 *
 * The data-layer modules (lib/workbench/{session-store,pro-home-data,
 * workspace-panes,workspace-order,workspace-paging,workspace-tree,
 * owner-session-client,course-refs,element-refs}) now exist as real
 * implementations and are deliberately NOT declared here — declaring them
 * shadowed the real exports (TS2305/TS2724) and broke both the data layer and
 * its tests.
 */
declare module '@/lib/hooks/use-home-discovery' {
  import type { ReactElement } from 'react';
  export type HomeDiscoveryState = 'loading' | 'ready' | 'error';
  export type HomeDiscoveryMode = 'full' | 'discover-only';
  /** The subset of `StageListItem` the workspace reads (reference shape). */
  export interface DiscoveryCourse {
    id: string;
    name: string;
    description?: string;
    sceneCount: number;
    createdAt: number;
    updatedAt: number;
    interactiveMode?: boolean;
    taskEngineMode?: boolean;
    folderId?: string;
    isOwner?: boolean;
  }
  /** The subset of `FolderRecord` the workspace reads (reference shape). */
  export interface DiscoveryFolder {
    id: string;
    name: string;
    order: number;
    createdAt: number;
    updatedAt: number;
  }
  export interface HomeDiscovery {
    state: HomeDiscoveryState;
    classrooms: DiscoveryCourse[];
    folders: DiscoveryFolder[];
    importing: boolean;
    importInput: ReactElement;
    discoveryContent: ReactElement;
    reload: () => Promise<void>;
    triggerImport: () => void;
    moveCourse: (courseId: string, folderId?: string) => Promise<void> | void;
    /** Tombstone an authored course; resolves true when the delete landed. */
    deleteCourse: (stageId: string) => Promise<boolean>;
  }
  export function useHomeDiscovery(options?: { readonly mode?: HomeDiscoveryMode }): HomeDiscovery;
}

declare module '@/lib/workbench/workspace-rail-tab' {
  export type RailTab = 'sessions' | 'courses';
  export const RAIL_TAB_STORAGE_KEY: string;
  export function resolveRailTab(options: {
    readonly stored?: string | null;
    readonly hasOpenCourse?: boolean;
  }): RailTab;
}

declare module '@/lib/workbench/workspace-navigation' {
  import type { SessionStatus } from '@/lib/workbench/session-store';
  export interface WorkspaceSessionPresentation {
    readonly labelKey: string;
    readonly tone: 'live' | 'error' | 'idle';
  }
  export function presentWorkspaceSession(
    status: Exclude<SessionStatus, 'idle'>,
  ): WorkspaceSessionPresentation;
  export const RAIL_WIDTH_DEFAULT: number;
  export const RAIL_WIDTH_STORAGE_KEY: string;
  export function clampRailWidth(width: number): number;
  export function parseRailWidth(stored: string | null): number;
}

declare module '@/lib/live/server-api' {
  export const STAGE_NAME_MAX_LENGTH: number;
  export class StageRenameError extends Error {
    readonly kind: 'invalidName' | 'forbidden' | 'notFound' | 'failed';
  }
  export const apiRenameStage: (id: string, name: string) => Promise<string>;
}

declare module '@/lib/workbench/session-title' {
  export interface WorkbenchSessionNaming {
    readonly title?: string | null;
    readonly prompt?: string | null;
  }
  export const SESSION_TITLE_MAX_LENGTH: number;
  export function workbenchSessionTitle(session: WorkbenchSessionNaming): string | null;
  export type SessionRenameOutcome = 'unchanged' | 'renamed' | 'failed';
  export function commitSessionRename(input: {
    readonly current: WorkbenchSessionNaming;
    readonly raw: string;
    readonly apply: (title: string | null) => void;
    readonly save: (title: string | null) => Promise<string | null>;
  }): Promise<SessionRenameOutcome>;
}

declare module '@/lib/workbench/pro-swap' {
  export function arrivedByProSwap(): boolean;
  export function startProSwap(href: string, push: (href: string) => void): void;
}

declare module '@/lib/workbench/use-workbench-pro-edit' {
  export const useWorkbenchProEditing: () => void;
}

declare module '@/lib/workbench/workspace-actions' {
  export function deleteWorkspaceSession(id: string): Promise<{ deleted: boolean }>;
}

declare module '@/lib/workbench/course-chat-bootstrap' {
  export type CourseChatBootstrap =
    | { readonly kind: 'settled' }
    | { readonly kind: 'adopt'; readonly sessionId: string; readonly courseId: string }
    | { readonly kind: 'draft'; readonly courseId: string };
  export function resolveCourseChatBootstrap(input: {
    readonly courseId: string | null;
    readonly sessionId: string | null;
    readonly attachedSessionId?: string | null;
    readonly newConversationRequested?: boolean;
    readonly sessions: readonly {
      readonly id: string;
      readonly updatedAt?: number;
      readonly createdAt?: number;
    }[];
    readonly sessionsLoaded: boolean;
  }): CourseChatBootstrap;
}

declare module '@/lib/workbench/first-message-session' {
  export interface FirstMessageResult {
    readonly sessionId: string;
    readonly elementRefsAccepted: boolean;
    readonly courseRefsAccepted: boolean;
  }
  export function startConversationWithFirstMessage(input: {
    readonly stageId: string;
    readonly text: string;
    readonly materials?: readonly unknown[];
    readonly elementRefs?: readonly unknown[];
    readonly courseRefs?: readonly unknown[];
  }): Promise<FirstMessageResult>;
}

declare module '@/lib/workbench/created-course-tabs' {
  export interface CreatedCourseTabsInput {
    readonly sessionId: string | null;
    readonly createdCourseIds: readonly string[];
    readonly replayedCourseCount: number;
    readonly availableCourseIds: readonly string[];
    readonly openCourseIds: readonly string[];
    readonly closedCourseIds: readonly string[];
    readonly replaying: boolean;
  }
  export function createdCourseTabsToOpen(input: CreatedCourseTabsInput): readonly string[];
}

declare module '@/lib/workbench/use-workspace-pane-navigation' {
  import type { WorkspacePanes } from '@/lib/workbench/workspace-panes';
  export interface WorkspacePaneNavigation {
    readonly panes: WorkspacePanes;
    readonly push: (next: WorkspacePanes) => void;
    readonly replace: (next: WorkspacePanes) => void;
  }
  export function useWorkspacePaneNavigation(initialPanes: WorkspacePanes): WorkspacePaneNavigation;
}

declare module '@/lib/workbench/workspace-course-tabs' {
  import type { WorkspaceCourseTabs } from '@/lib/workbench/workspace-panes';
  export function readCourseTabsMemory(): WorkspaceCourseTabs | null;
  export function writeCourseTabsMemory(tabs: WorkspaceCourseTabs): void;
}

declare module '@/lib/workbench/workspace-session-memory' {
  export function rememberWorkspaceSession(sessionId: string): void;
  export function forgetWorkspaceSession(sessionId: string): void;
}

declare module '@/lib/brand/brand-context' {
  export interface BrandConfig {
    productName: string;
    shortName: string;
    logoSrc: string;
    logoHasWordmark: boolean;
    markSrc: string;
    themeColor: string;
  }
  export const useBrand: () => BrandConfig;
  export const useIsDesktop: () => boolean;
}

declare module '@/components/workbench/ProBadge' {
  import type { ComponentType } from 'react';
  export const ProBadge: ComponentType<any>;
}
declare module '@/components/workbench/ProLaunchPanel' {
  import type { ComponentType } from 'react';
  export const ProLaunchPanel: ComponentType<any>;
}
declare module '@/components/classroom/ClassroomSurface' {
  import type { ComponentType } from 'react';
  export const ClassroomSurface: ComponentType<any>;
}
declare module '@/components/site-header/theme-toggle' {
  import type { ComponentType } from 'react';
  export const ThemeToggle: ComponentType<any>;
}
declare module '@/components/ui/floating-layer-owner' {
  import type { ComponentType, ReactNode } from 'react';
  export const FloatingLayerOwner: ComponentType<{ ownerId: string; children: ReactNode }>;
  export const installFloatingLayerDismissListeners: (options: any) => () => void;
}
