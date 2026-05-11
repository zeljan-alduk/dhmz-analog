"use client";

import { createContext, useContext } from "react";

/**
 * `DhmzHost` is the API surface exposed to JSX components mounted into
 * customization slots. Compiled JSX runs in the host React context (not an
 * iframe sandbox) so it could call anything in `window`; this object is just
 * the *stable* surface that survives host refactors.
 *
 * Anything the host doesn't intentionally expose here is fair game to break
 * across versions — saved customizations that reach beyond `host` may stop
 * working when the app evolves. That's an accepted trade for power.
 */

export interface SessionStateView {
  id: string | null;
  version: number;
  chartType: string | null;
  rotationDeg: number;
  imageNaturalSize: [number, number] | null;
  imageUrl: string | null;
  dataPointsCount: number;
  hasCalibration: boolean;
}

export interface DhmzHostApi {
  /** Reload the session state (forces an immediate fetch). */
  refresh: () => Promise<void>;
  /** POST a chat message (visible in session chat). Useful for "I clicked X" feedback. */
  postChat: (text: string) => Promise<void>;
  /** Trigger extract-trace on the current session. */
  extractTrace: (opts?: {
    traceInk?: "auto" | "blue" | "red" | "black";
    samplesPerDay?: number;
  }) => Promise<void>;
  /** Download current data points as CSV. */
  downloadCsv: () => void;
  /** Generic backend POST for advanced use. Returns parsed JSON. */
  fetchJson: <T = unknown>(
    path: string,
    init?: RequestInit
  ) => Promise<T>;
}

export interface DhmzHost {
  state: SessionStateView;
  api: DhmzHostApi;
  /**
   * The host's React reference. Saved customizations import hooks like
   * `host.React.useState` to avoid a separate React import path inside the
   * compiled snippet.
   */
  React: typeof import("react");
}

export const DhmzHostContext = createContext<DhmzHost | null>(null);

export function useDhmzHost(): DhmzHost {
  const h = useContext(DhmzHostContext);
  if (!h) {
    throw new Error(
      "useDhmzHost called outside <DhmzHostProvider>. Slot components and " +
        "version-manager UI must be rendered inside the provider."
    );
  }
  return h;
}
