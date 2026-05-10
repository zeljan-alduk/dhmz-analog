"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface SessionInfo {
  id: string;
  url: string;
  claudeUrl: string;
  expiresAt: number;
}

export function SessionBanner({
  info,
  onDismiss,
}: {
  info: SessionInfo;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<"url" | "prompt" | null>(null);

  const claudePrompt = `${info.url} — pomozi digitalizirati ovaj sken`;

  const copy = async (text: string, kind: "url" | "prompt") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1600);
    } catch (e) {
      console.warn("clipboard write failed", e);
    }
  };

  // Esc to dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const minutes = Math.max(
    0,
    Math.floor((info.expiresAt - Date.now() / 1000) / 60)
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-xl rounded-xl bg-white shadow-2xl border border-neutral-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-200 bg-neutral-50">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            <h2 className="text-sm font-semibold text-neutral-900">
              Sesija je spremna za Claude
            </h2>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-neutral-500 hover:text-neutral-900 text-lg leading-none"
            aria-label="Zatvori"
          >
            ×
          </button>
        </header>

        <div className="p-5 space-y-5">
          <p className="text-sm text-neutral-700 leading-relaxed">
            Sken je pripremljen kao session koju može voditi Claude. Pokreni{" "}
            <code className="font-mono text-[12px] bg-neutral-100 px-1 rounded">
              claude
            </code>{" "}
            u repu projekta i pošalji mu ovaj URL — vidjet ćeš njegov rad uživo
            ovdje u browseru.
          </p>

          <CopyBlock
            label="Session URL"
            value={info.url}
            copied={copied === "url"}
            onCopy={() => copy(info.url, "url")}
          />

          <CopyBlock
            label="Prompt za terminal"
            multiline
            value={claudePrompt}
            copied={copied === "prompt"}
            onCopy={() => copy(claudePrompt, "prompt")}
          />

          <div className="text-[11px] text-neutral-500 leading-relaxed flex items-center gap-3">
            <span>Sesija istječe za ~{minutes} min.</span>
            <span className="font-mono">{info.id}</span>
          </div>
        </div>

        <footer className="flex items-center justify-between px-5 py-3 border-t border-neutral-200 bg-neutral-50">
          <a
            href={info.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline font-medium"
          >
            Otvori session view ↗
          </a>
          <button
            type="button"
            onClick={onDismiss}
            className="px-3 py-1.5 rounded text-xs font-medium bg-neutral-900 text-white hover:bg-neutral-700"
          >
            Nastavi sam
          </button>
        </footer>
      </div>
    </div>
  );
}

function CopyBlock({
  label,
  value,
  multiline,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
          {label}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className={cn(
            "text-[11px] font-medium px-2 py-0.5 rounded border transition-colors",
            copied
              ? "bg-emerald-500 border-emerald-500 text-white"
              : "bg-white border-neutral-300 text-neutral-700 hover:bg-neutral-100"
          )}
        >
          {copied ? "Kopirano" : "Kopiraj"}
        </button>
      </div>
      <code
        className={cn(
          "block bg-neutral-100 border border-neutral-200 rounded px-3 py-2 text-[12px] font-mono text-neutral-900 break-all",
          multiline && "whitespace-pre-wrap"
        )}
      >
        {value}
      </code>
    </div>
  );
}
