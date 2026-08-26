/* eslint-disable @typescript-eslint/no-explicit-any -- temporary sibling API declarations. */
/** Compile-time bridge for the independently landed U1/U2 slices. */
declare module '@/lib/hooks/use-home-discovery' {
  import type { ReactNode } from 'react';
  export type HomeDiscoveryState = 'idle' | 'loading' | 'ready' | 'error';
  export interface DiscoveryCourse {
    id: string;
    name: string;
    sceneCount: number;
    folderId?: string;
    isOwner?: boolean;
  }
  export interface DiscoveryFolder {
    id: string;
    name: string;
  }
  export function useHomeDiscovery(options?: unknown): {
    state: HomeDiscoveryState;
    classrooms: DiscoveryCourse[];
    folders: DiscoveryFolder[];
    importing: boolean;
    importInput: ReactNode;
    discoveryContent: ReactNode;
    reload: () => Promise<void> | void;
    triggerImport: () => void;
    moveCourse: (courseId: string, folderId?: string) => Promise<void>;
  };
}

declare module '@/lib/workbench/pro-home-data' {
  export interface ProHomeSessionItem {
    id: string;
    title?: string | null;
    prompt?: string | null;
    stageId?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    status: 'connecting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  }
  export const newestFirst: <T extends { updatedAt?: string | null; createdAt?: string | null }>(
    items: readonly T[],
  ) => T[];
  export const relativeBucket: (value?: string | null) => 'now' | 'minutes' | 'hours' | 'days';
  export const reconcileAttachedSessionStatus: (...args: unknown[]) => ProHomeSessionItem[];
}

declare module '@/lib/workbench/session-store' {
  export interface WorkbenchMaterial {
    id: string;
    [key: string]: unknown;
  }
  export interface WorkbenchState {
    sessionId: string | null;
    sessionTitle: string | null;
    sessionPrompt: string | null;
    connected: boolean;
    generationOpen: boolean;
    waitingKey: string | null;
    waitingArmed: boolean;
    playbackOn: boolean;
    setPlaybackOn: (value: boolean) => void;
    setSessionTitle: (title: string | null) => void;
    [key: string]: unknown;
  }
  export interface WorkbenchStoreHook {
    <T>(selector: (state: WorkbenchState) => T): T;
    getState(): WorkbenchState;
  }
  export const useWorkbenchStore: WorkbenchStoreHook;
  export const renameWorkbenchSession: (sessionId: string, title: string | null) => Promise<void>;
}

declare module '@/lib/workbench/panel-context' {
  import type { ComponentType, ReactNode } from 'react';
  export interface WorkbenchCourseSummary {
    id: string;
    name: string;
    [key: string]: unknown;
  }
  export interface WorkbenchCourseNavigation {
    [key: string]: unknown;
  }
  export interface WorkbenchDraftConversation {
    [key: string]: unknown;
  }
  export const WorkbenchCourseNavigationProvider: ComponentType<{
    navigation: WorkbenchCourseNavigation;
    children: ReactNode;
  }>;
  export const WorkbenchDraftConversationProvider: ComponentType<{
    draft: WorkbenchDraftConversation | null;
    children: ReactNode;
  }>;
  export const WorkbenchPanelProvider: ComponentType<{
    visible: boolean;
    playback: boolean;
    children: ReactNode;
  }>;
}

declare module '@/lib/workbench/course-mention' {
  export interface CourseMentionSource {
    id: string;
    name: string;
  }
}
declare module '@/lib/workbench/element-refs' {
  export interface ElementRef {
    [key: string]: unknown;
  }
}
declare module '@/lib/workbench/course-refs' {
  export interface CourseRef {
    [key: string]: unknown;
  }
}

declare module '@/lib/workbench/workspace-order' {
  export type DropTarget = { before: string } | { after: string };
  export const COURSE_ORDER_STORAGE_KEY: string;
  export const SESSION_ORDER_STORAGE_KEY: string;
  export const applyCustomOrder: <T extends { id: string }>(
    items: readonly T[],
    order: readonly string[],
  ) => T[];
  export const parseOrder: (value: string | null) => readonly string[];
  export const reorderIds: (ids: readonly string[], id: string, target: DropTarget) => string[];
  export const serializeOrder: (ids: readonly string[]) => string;
}

declare module '@/lib/workbench/workspace-paging' {
  export type PageMap = Readonly<Record<string, number>>;
  export const EMPTY_PAGES: PageMap;
  export const RAIL_INITIAL_ROWS: number;
  export const nextPage: (
    items: readonly unknown[],
    page: number,
    options: { initial: number },
  ) => number;
  export const pageList: <T>(
    items: readonly T[],
    page: number,
    options: { initial: number },
  ) => T[];
  export const pagesFor: (pages: PageMap, id: string) => number;
  export const withPages: (pages: PageMap, id: string, page: number) => PageMap;
}

declare module '@/lib/workbench/workspace-tree' {
  import type { DiscoveryCourse, DiscoveryFolder } from '@/lib/hooks/use-home-discovery';
  export const filterByName: <T extends { name: string }>(
    items: readonly T[],
    query: string,
  ) => T[];
  export const partitionByOwnership: (items: readonly DiscoveryCourse[]) => {
    owned: DiscoveryCourse[];
    saved: DiscoveryCourse[];
  };
  export const groupCoursesByFolder: (
    items: readonly DiscoveryCourse[],
    folders: readonly DiscoveryFolder[],
  ) => {
    groups: Array<{ folder: DiscoveryFolder; courses: DiscoveryCourse[] }>;
    ungrouped: DiscoveryCourse[];
  };
}

declare module '@/lib/workbench/workspace-rail-tab' {
  export type RailTab = 'sessions' | 'courses';
  export const RAIL_TAB_STORAGE_KEY: string;
  export const resolveRailTab: (options: {
    stored: string | null;
    hasOpenCourse: boolean;
  }) => RailTab;
}

declare module '@/lib/workbench/workspace-panes' {
  export interface WorkspacePanes {
    sessionId: string | null;
    courseId: string | null;
  }
  export const CHAT_COLLAPSED_STORAGE_KEY: string;
  export const CHAT_WIDTH_DEFAULT: number;
  export const CHAT_WIDTH_STORAGE_KEY: string;
  export const CLASSROOM_COLLAPSED_STORAGE_KEY: string;
  export const NAV_COLLAPSED_STORAGE_KEY: string;
  export const NO_COURSE_TABS: unknown;
  export const activateCourseTab: (...args: any[]) => any;
  export const clampChatWidth: (width: number) => number;
  export const closeCourseTab: (...args: any[]) => any;
  export const openCourseTab: (...args: any[]) => any;
  export const openCourseTabs: (...args: any[]) => any;
  export const parseChatWidth: (value: string | null) => number;
  export const parseCollapsed: (value: string | null) => boolean;
  export const readWorkspacePanes: (...args: any[]) => WorkspacePanes;
  export const resolveWorkspaceRender: (...args: any[]) => any;
  export const restoreCourseTabs: (...args: any[]) => any;
  export const samePanes: (a: WorkspacePanes, b: WorkspacePanes) => boolean;
  export const withCourse: (panes: WorkspacePanes, id: string | null) => WorkspacePanes;
  export const withSession: (panes: WorkspacePanes, id: string | null) => WorkspacePanes;
}

declare module '@/lib/workbench/workspace-navigation' {
  export const RAIL_WIDTH_DEFAULT: number;
  export const RAIL_WIDTH_STORAGE_KEY: string;
  export const clampRailWidth: (width: number) => number;
  export const parseRailWidth: (value: string | null) => number;
  export const presentWorkspaceSession: (...args: any[]) => any;
}

declare module '@/lib/workbench/owner-session-client' {
  export class OwnerSessionClient {
    constructor(options: any);
    start(): void;
    stop(): void;
  }
}

declare module '@/lib/live/server-api' {
  export const STAGE_NAME_MAX_LENGTH: number;
  export class StageRenameError extends Error {
    readonly kind: 'invalidName' | 'forbidden' | 'notFound';
  }
  export const apiRenameStage: (id: string, name: string) => Promise<void>;
}

declare module '@/lib/workbench/session-title' {
  export const SESSION_TITLE_MAX_LENGTH: number;
  export const workbenchSessionTitle: (session: {
    title?: string | null;
    prompt?: string | null;
  }) => string | null;
  export const commitSessionRename: (options: any) => Promise<string | null>;
}

declare module '@/lib/workbench/pro-swap' {
  export const arrivedByProSwap: boolean;
  export const startProSwap: (href: string, navigate: (href: string) => void) => void;
}

declare module '@/lib/workbench/use-workbench-pro-edit' {
  export const useWorkbenchProEditing: () => void;
}

declare module '@/lib/workbench/*' {
  const value: any;
  export = value;
}

declare module '@/lib/brand/brand-context' {
  export const useBrand: () => {
    logoSrc: string;
    markSrc: string;
    productName: string;
    logoHasWordmark: boolean;
    themeColor: string;
  };
  export const useIsDesktop: () => boolean;
}

declare module '@/components/workbench/WorkbenchChat' {
  import type { ComponentType } from 'react';
  export const WorkbenchChat: ComponentType<any>;
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
