"use client";

import { useEffect, useState } from "react";
import type { Customization, SlotMount } from "@/lib/customizations/types";
import { saveVersion } from "@/lib/customizations/storage";
import { cn } from "@/lib/utils";

/**
 * Shown when the user arrives via `?cv=<id>` — fetches the customization
 * from the share store and asks for explicit consent before applying.
 * Customizations execute arbitrary code in the host page, so this is the
 * security boundary for shared links.
 */
export function ImportModal({
  customizationId,
  onClose,
  onApply,
}: {
  customizationId: string;
  onClose: () => void;
  onApply: (c: Customization, name: string | null) => Promise<void> | void;
}) {
  const [data, setData] = useState<
    | (Customization & { name?: string | null; createdAt?: number })
    | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/customizations/${customizationId}`);
        if (!alive) return;
        if (!r.ok) {
          setLoadError(
            r.status === 404
              ? "This shared customization is gone or expired."
              : `Load failed (HTTP ${r.status}).`
          );
          return;
        }
        setData(await r.json());
      } catch (e) {
        if (alive) setLoadError(`Load failed: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [customizationId]);

  const handleApply = async (alsoSaveLocally: boolean) => {
    if (!data) return;
    setApplying(true);
    try {
      const cust: Customization = { css: data.css, slots: data.slots };
      await onApply(cust, data.name ?? null);
      if (alsoSaveLocally) {
        saveVersion(
          data.name || `imported-${customizationId.slice(0, 6)}`,
          cust,
          { remoteId: customizationId }
        );
      }
      onClose();
    } catch (e) {
      setLoadError(`Apply failed: ${(e as Error).message}`);
    } finally {
      setApplying(false);
    }
  };

  const slotEntries = Object.entries(data?.slots || {}) as [
    string,
    SlotMount
  ][];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-xl rounded-xl bg-white shadow-2xl border border-neutral-200 overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-200 bg-amber-50">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
            <h2 className="text-sm font-semibold text-neutral-900">
              Import shared customization
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-900 text-lg leading-none"
          >
            ×
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto">
          {loadError && (
            <div
              role="alert"
              className="text-sm text-red-800 bg-red-50 border border-red-200 px-3 py-2 rounded"
            >
              {loadError}
            </div>
          )}

          {!loadError && !data && (
            <div className="text-sm text-neutral-500 py-6 text-center">
              Loading…
            </div>
          )}

          {data && (
            <>
              <div className="text-sm text-neutral-700 space-y-2 leading-relaxed">
                <p>
                  <strong>{data.name || "(no name)"}</strong> — id{" "}
                  <code className="bg-neutral-100 px-1 rounded text-[12px]">
                    {customizationId}
                  </code>
                </p>
                <p className="text-amber-900 bg-amber-50 border border-amber-200 px-3 py-2 rounded">
                  This customization can run arbitrary JSX in this page&apos;s
                  context — it can read your session state, talk to the
                  backend, and replace UI controls. Only apply if you trust
                  the source.
                </p>
              </div>

              <div className="text-[12px] text-neutral-700 space-y-2">
                {data.css?.trim() && (
                  <details>
                    <summary className="cursor-pointer text-neutral-600 hover:text-neutral-900">
                      CSS ({data.css.length} bytes)
                    </summary>
                    <pre className="bg-neutral-50 border border-neutral-200 rounded p-2 mt-1 overflow-auto text-[11px] font-mono max-h-40">
                      {data.css}
                    </pre>
                  </details>
                )}
                {slotEntries.map(([slot, m]) => (
                  <details key={slot}>
                    <summary className="cursor-pointer text-neutral-600 hover:text-neutral-900">
                      Slot <code>{slot}</code> · {m.name} ({m.jsx.length} bytes)
                    </summary>
                    <pre className="bg-neutral-50 border border-neutral-200 rounded p-2 mt-1 overflow-auto text-[11px] font-mono max-h-60">
                      {m.jsx}
                    </pre>
                  </details>
                ))}
              </div>
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 px-5 py-3 border-t border-neutral-200 bg-neutral-50">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium border border-neutral-300 rounded hover:bg-neutral-100"
            disabled={applying}
          >
            Cancel
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleApply(false)}
              disabled={!data || applying}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded border border-neutral-300",
                data ? "hover:bg-neutral-100" : "opacity-50 cursor-not-allowed"
              )}
            >
              Apply once
            </button>
            <button
              type="button"
              onClick={() => handleApply(true)}
              disabled={!data || applying}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded",
                data
                  ? "bg-neutral-900 text-white hover:bg-neutral-700"
                  : "bg-neutral-200 text-neutral-500 cursor-not-allowed"
              )}
            >
              {applying ? "Applying…" : "Apply + save locally"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
