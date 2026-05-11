/**
 * Live UI customization layer — Claude (or the user) can attach CSS overrides
 * + JSX-authored React components into named "slots" on the host page.
 *
 * Customization shapes
 * --------------------
 *  - `Customization`    : full payload (CSS + slot mounts) that lives on the
 *                         session (server-side, mutated by MCP) and can be
 *                         saved as a named version locally.
 *  - `SlotMount`        : one component injection into a slot — JSX source
 *                         (compiled in-browser via Sucrase) + a human label.
 *  - `SavedVersion`     : a `Customization` with metadata (id, name, ts,
 *                         optional remote share-id) persisted to localStorage.
 *
 * Slots are an enum of stable string ids. Adding a new slot = adding a new
 * mount point in the host JSX + listing it here.
 */

export type SlotId =
  | "toolbar-extra"      // right-end of the top toolbar (next to existing controls)
  | "sidebar-extra"      // bottom of the right sidebar (under data points)
  | "overlay"            // full-screen overlay above the chart (modal-ish)
  | "route";             // standalone sub-page replacing the main view

export const SLOT_IDS: readonly SlotId[] = [
  "toolbar-extra",
  "sidebar-extra",
  "overlay",
  "route",
] as const;

export interface SlotMount {
  /** Display label shown in the version manager + dev tools. */
  name: string;
  /**
   * JSX/TSX source. Must define a React component named `Component` that
   * takes a `host: DhmzHost` prop and returns JSX. Compiled at mount time
   * via Sucrase.
   *
   * Example:
   *   function Component({ host }) {
   *     return <button onClick={() => host.api.extractTrace()}>Run extract</button>;
   *   }
   */
  jsx: string;
}

export interface Customization {
  /** Optional raw CSS string applied via `<style id="dhmz-cust-css">` on body. */
  css?: string;
  /** Slot mounts keyed by SlotId. */
  slots?: Partial<Record<SlotId, SlotMount>>;
}

export function isCustomizationEmpty(c: Customization | null | undefined): boolean {
  if (!c) return true;
  if (c.css && c.css.trim()) return false;
  if (c.slots && Object.keys(c.slots).length > 0) return false;
  return true;
}

export interface SavedVersion extends Customization {
  /** Stable client-generated id (UUID-ish). */
  id: string;
  /** User-supplied name (e.g. "Compact toolbar v1"). */
  name: string;
  /** Unix seconds. */
  ts: number;
  /**
   * Remote short-id from `POST /api/customizations`. Set once the version has
   * been shared; absent if never uploaded. Used to short-circuit re-uploads.
   */
  remoteId?: string;
}
