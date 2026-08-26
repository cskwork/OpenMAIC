/**
 * The workbench chat's one layout constant from the container-geometry module.
 *
 * The full reference `lib/edit/contain-box.ts` (the 16:9 contain/fill helpers,
 * `CLASSROOM_ASPECT_RATIO`, the panel minima) is owned by the workspace-shell
 * slice; this file is the thin local stand-in the chat surface compiles against,
 * carrying only the constant the chat itself reads. When the shell slice lands
 * the full module, this file is superseded.
 */
/** Conversation column never shrinks below this in a side-by-side host. */
export const WORKBENCH_CHAT_MIN_PX = 400;
