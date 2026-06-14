/**
 * Gates the editor's two scene-creation entry points — the inter-thumb "+"
 * insertion zones and the per-slide Duplicate menu item.
 *
 * Enabled now that the editor can author a scene's playback `actions`:
 * duplicated slides carry the source's actions (playable as-is), and a blank
 * inserted slide starts with no narration — the user fills it in via the
 * script timeline / MAIC Agent (the playback engine skips a scene with no
 * actions until then). Reorder / delete / rename were always playback-safe.
 */
export const SCENE_CREATION_ENABLED = true;
