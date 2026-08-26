import { describe, expect, it } from 'vitest';
import { STAGE_WRITER_TOOL_NAMES, isStageWriterTool } from '@/lib/agent-runtime/stage-writer-tools';

/**
 * The stage-writer registry is the single source of truth for "which agent
 * tools WRITE a stage document". The cross-module consistency assertions
 * against the server scheduler (`DOCUMENT_WRITING_TOOLS`) and the per-toolset
 * writer lists live in this suite once those modules land in a later slice;
 * here the registry's own contents and the reader/writer split are pinned.
 */
describe('stage writer registry is the single source', () => {
  it('every registered name is recognized as a writer', () => {
    for (const name of STAGE_WRITER_TOOL_NAMES) {
      expect(isStageWriterTool(name)).toBe(true);
    }
  });

  it('pins the exact writer set so scheduling/ownership cannot drift silently', () => {
    expect([...STAGE_WRITER_TOOL_NAMES].sort()).toEqual(
      [
        // course generation writers
        'set_roster',
        'generate_scene',
        'generate_actions',
        'duplicate_scene',
        'import_pptx',
        // course audio and page-list writers
        'generate_tts',
        'edit_deck',
        // generic stage-document writer
        'patch_stage',
        // curriculum writer (stage identity)
        'rename_stage',
      ].sort(),
    );
  });

  it('reader tools are NOT writers — ownership must never arm on them', () => {
    for (const reader of [
      'read_stage',
      'grep_stage',
      'list_scenes',
      'read_stage_outline',
      'list_folder_stages',
      'render_scene_preview',
      'generate_image',
      'use_material_media',
      'generate_video',
    ]) {
      expect(isStageWriterTool(reader)).toBe(false);
    }
  });
});
