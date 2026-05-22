'use client';

import { AnchoredBar } from './AnchoredBar';
import { DeleteButton } from './DeleteButton';

interface AnchoredImageBarProps {
  /** The selected image element, or "" when no image element is selected. */
  readonly imageElementId: string;
}

/**
 * The selection-anchored bar for an image element. Images have no format
 * controls yet, so it carries just the delete action (image replace / crop /
 * flip are a later sub-PR). Hugs the selected image — see AnchoredBar.
 */
export function AnchoredImageBar({ imageElementId }: AnchoredImageBarProps) {
  return (
    <AnchoredBar elementId={imageElementId}>
      <DeleteButton elementId={imageElementId} />
    </AnchoredBar>
  );
}
