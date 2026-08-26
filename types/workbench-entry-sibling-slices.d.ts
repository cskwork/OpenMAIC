/* eslint-disable @typescript-eslint/no-explicit-any -- temporary sibling API declarations. */
/**
 * Compile-time contracts for the independently landed workbench data, chat,
 * and workspace-shell slices. Remove this bridge when those branches merge;
 * it intentionally contains declarations only, never fallback behavior.
 */

declare module '@/components/workbench/workspace/WorkspaceShell' {
  import type { ComponentType } from 'react';
  export const WorkspaceShell: ComponentType;
}
