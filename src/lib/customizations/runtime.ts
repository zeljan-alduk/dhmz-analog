"use client";

import * as React from "react";
import { useEffect } from "react";
import { applyCustomizationCss } from "./slots";
import type { DhmzHost, DhmzHostApi, SessionStateView } from "./host-api";

/**
 * Effect: apply the customization CSS to <head> when it changes. Cleans up
 * on unmount so the host returns to default styling.
 */
export function useCustomizationCss(css: string | null | undefined): void {
  useEffect(() => {
    const cleanup = applyCustomizationCss(css || null);
    return cleanup;
  }, [css]);
}

/**
 * Build the `host` object that gets injected into compiled JSX components.
 * Everything is bound to a specific session-id (or null when on the base
 * page); api calls without a session-id no-op silently or fall back to
 * generic backend routes.
 */
export function buildDhmzHost(opts: {
  sessionId: string | null;
  state: SessionStateView;
  refresh: () => Promise<void>;
}): DhmzHost {
  const { sessionId, state, refresh } = opts;

  async function call(path: string, init?: RequestInit) {
    if (!sessionId && path.startsWith("/sessions/")) {
      throw new Error(
        "host.api requires an active session; not available on the base page"
      );
    }
    const url = path.startsWith("/api/") ? path : `/api${path}`;
    const resp = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    if (!resp.ok) {
      throw new Error(
        `dhmzHost ${init?.method || "GET"} ${path} → HTTP ${resp.status}`
      );
    }
    const ct = resp.headers.get("content-type") || "";
    return ct.includes("application/json") ? resp.json() : resp.text();
  }

  const api: DhmzHostApi = {
    refresh,
    postChat: async (text) => {
      if (!sessionId) throw new Error("no active session");
      await call(`/sessions/${sessionId}/chat`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    },
    extractTrace: async (opts) => {
      if (!sessionId) throw new Error("no active session");
      const body: Record<string, unknown> = {
        traceInk: opts?.traceInk ?? "auto",
        samplesPerDay: opts?.samplesPerDay ?? 48,
      };
      await call(`/sessions/${sessionId}/extract-trace`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await refresh();
    },
    downloadCsv: () => {
      if (!sessionId) return;
      window.location.href = `/api/sessions/${sessionId}/csv`;
    },
    fetchJson: async <T,>(path: string, init?: RequestInit) =>
      (await call(path, init)) as T,
  };

  return { state, api, React };
}
