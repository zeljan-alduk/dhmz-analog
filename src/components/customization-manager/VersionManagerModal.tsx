"use client";

import { useEffect, useState } from "react";
import type { Customization, SavedVersion } from "@/lib/customizations/types";
import {
  deleteAllVersions,
  deleteVersion,
  listVersions,
  saveVersion,
  updateVersion,
} from "@/lib/customizations/storage";
import { cn } from "@/lib/utils";

/**
 * Version manager + share modal. Lists localStorage-saved customizations,
 * allows save/load/revert/delete + per-version share. Save/share calls
 * upload to /api/customizations to obtain a short id, then writes that id
 * back to the localStorage entry as `remoteId`.
 */
export function VersionManagerModal({
  active,
  onClose,
  onApply,
  onRevert,
}: {
  active: Customization | null;
  onClose: () => void;
  onApply: (c: Customization) => Promise<void> | void;
  onRevert: () => Promise<void> | void;
}) {
  const [versions, setVersions] = useState<SavedVersion[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refresh = () => setVersions(listVersions());

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isActiveDirty =
    !!active && (!!active.css?.trim() || Object.keys(active.slots || {}).length > 0);

  const handleSave = async () => {
    if (!isActiveDirty) {
      setError("Nothing to save — host UI is at defaults.");
      return;
    }
    setBusy("saving");
    setError(null);
    try {
      const v = saveVersion(name || "untitled", active!);
      refresh();
      setName("");
      // Best-effort upload so the version gets a shareable id immediately.
      try {
        const resp = await fetch("/api/customizations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: v.name, css: v.css, slots: v.slots }),
        });
        if (resp.ok) {
          const { id } = (await resp.json()) as { id: string };
          updateVersion(v.id, { remoteId: id });
          refresh();
        }
      } catch {
        /* offline share — local save still succeeded */
      }
    } catch (e) {
      setError(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleApply = async (v: SavedVersion) => {
    setBusy(`apply-${v.id}`);
    setError(null);
    try {
      await onApply({ css: v.css, slots: v.slots });
    } catch (e) {
      setError(`Apply failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = (v: SavedVersion) => {
    if (!confirm(`Delete version "${v.name}"?`)) return;
    deleteVersion(v.id);
    refresh();
  };

  const handleDeleteAll = () => {
    if (!confirm(`Delete all ${versions.length} saved versions? Can't undo.`)) return;
    deleteAllVersions();
    refresh();
  };

  const handleShare = async (v: SavedVersion) => {
    setBusy(`share-${v.id}`);
    setError(null);
    let remoteId = v.remoteId;
    try {
      if (!remoteId) {
        const resp = await fetch("/api/customizations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: v.name, css: v.css, slots: v.slots }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        remoteId = ((await resp.json()) as { id: string }).id;
        updateVersion(v.id, { remoteId });
        refresh();
      }
      const url = `${window.location.origin}/?cv=${remoteId}`;
      await navigator.clipboard.writeText(url);
      setCopiedId(v.id);
      setTimeout(() => setCopiedId((cur) => (cur === v.id ? null : cur)), 1800);
    } catch (e) {
      setError(`Share failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-2xl rounded-xl bg-white shadow-2xl border border-neutral-200 overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-200 bg-neutral-50">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-neutral-900">
              UI customizations
            </h2>
            <span className="text-[11px] text-neutral-500">
              {isActiveDirty ? "live changes active" : "default"} ·{" "}
              {versions.length} saved
            </span>
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
          {error && (
            <div
              className="text-[12px] text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded"
              role="alert"
            >
              {error}
            </div>
          )}

          <section className="space-y-2">
            <h3 className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
              Active session
            </h3>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Save current as…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 text-sm px-3 py-1.5 border border-neutral-300 rounded focus:outline-none focus:border-neutral-500"
                disabled={!isActiveDirty}
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={!isActiveDirty || busy !== null}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded transition-colors",
                  isActiveDirty
                    ? "bg-neutral-900 text-white hover:bg-neutral-700"
                    : "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                )}
              >
                {busy === "saving" ? "Saving…" : "Save version"}
              </button>
              <button
                type="button"
                onClick={() => onRevert()}
                disabled={!isActiveDirty || busy !== null}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded transition-colors",
                  isActiveDirty
                    ? "border border-neutral-300 text-neutral-800 hover:bg-neutral-100"
                    : "border border-neutral-200 text-neutral-400 cursor-not-allowed"
                )}
              >
                Revert
              </button>
            </div>
            {isActiveDirty && (
              <div className="text-[11px] text-neutral-500 flex gap-3">
                {active?.css?.trim() && <span>· {active.css.length} bytes CSS</span>}
                {Object.entries(active?.slots || {}).map(([slot, m]) => (
                  <span key={slot}>
                    · {slot}: {m.name}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
                Saved versions ({versions.length})
              </h3>
              {versions.length > 0 && (
                <button
                  type="button"
                  onClick={handleDeleteAll}
                  className="text-[11px] text-red-700 hover:underline"
                >
                  Delete all
                </button>
              )}
            </div>
            {versions.length === 0 ? (
              <div className="text-[12px] text-neutral-500 italic py-4 text-center">
                No saved versions yet. Save the active customization above.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {versions.map((v) => (
                  <li
                    key={v.id}
                    className="border border-neutral-200 rounded px-3 py-2 flex items-center gap-3 hover:bg-neutral-50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-neutral-900 truncate">
                        {v.name}
                      </div>
                      <div className="text-[11px] text-neutral-500 truncate">
                        {new Date(v.ts * 1000).toLocaleString()}
                        {v.css?.trim() && ` · ${v.css.length} B CSS`}
                        {v.slots &&
                          Object.keys(v.slots).length > 0 &&
                          ` · ${Object.keys(v.slots).join(", ")}`}
                        {v.remoteId && ` · shared (id ${v.remoteId.slice(0, 8)}…)`}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleApply(v)}
                      disabled={busy !== null}
                      className="text-xs px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-100"
                    >
                      {busy === `apply-${v.id}` ? "…" : "Apply"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleShare(v)}
                      disabled={busy !== null}
                      className={cn(
                        "text-xs px-2 py-1 rounded border",
                        copiedId === v.id
                          ? "bg-emerald-500 border-emerald-500 text-white"
                          : "border-neutral-300 hover:bg-neutral-100"
                      )}
                    >
                      {copiedId === v.id
                        ? "Copied"
                        : busy === `share-${v.id}`
                        ? "…"
                        : "Share"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(v)}
                      disabled={busy !== null}
                      className="text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50"
                    >
                      Del
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
