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

  const [mode, setMode] = useState<"cli" | "desktop">("cli");

  const cliPrompt = `${info.url} — pomozi mi digitalizirati ovaj sken.

KOMUNIKACIJSKI STIL:

- Glavni prozor je session web chat (browser). Sve što radiš mora
  biti tamo vidljivo kao live screen-share: kratak plan na početku,
  pa "doing X → done, Y points, range Z" za svaki korak, pa
  završni sažetak. Bez tišine, bez monoloških zidova.
- Razmišljanje koje vodi do odluke (zašto baš ove kalibracijske
  korne, zašto traceInk=blue, zašto jpeg umjesto png) eksplicitno
  napiši u chat poruku — web chat ne prikazuje tvoje thinking
  blokove sam od sebe. Trivijalnosti (state read) preskoči.
- U terminal pišeš najviše jednu kratku liniju po koraku
  ("posting status, running extract"). Sva soft content ide u chat.

OPERATIVNA AUTONOMIJA:

- Briefing s /context čitaš jednom kao **prijedlog**, ne nalog.
  Sažmi mi ga u 2-3 rečenice u chatu i KREĆI. Ne traži OK osim
  ako tražim drugačije.
- Plan → izvedi → komentiraj usput. Ne čekaj između koraka.
  Konkretno: kalibracija → extract → CSV kreće bez pauze, samo
  s vidljivim status-postovima.
- Pitaj me SAMO kad: (a) stvarna ambivalencija (dvije podjednako
  dobre interpretacije skena), ili (b) prije destruktivnog koraka
  (POST /image swap, DELETE /annotations, DELETE /data-points).
- "stop" konvencija: između koraka pozovi
  /chat?since=N&wait=2 (skoro non-blocking). Ako stigne poruka
  koja sadrži "stop", prekini i čekaj daljnje upute. Inače idi
  dalje bez dodatne provjere.
- Dugi pozivi (extract-trace 30-60s): najavi "⏳ Vrtim:
  extract-trace (~30s)", izvrši, objavi rezultate (+ overlay
  attachment kad smisleno). Bez blokiranja na potvrdu prije.

LIVE UI CUSTOMIZATION:

Kad korisnik traži promjenu izgleda alata ("dodaj gumb za X",
"sakri kalibracijski panel", "novi pregled koji..."), NE diraj
repo. Koristi customization endpointe:

  PUT /api/sessions/<sid>/customization/css { "css": "..." }
  PUT /api/sessions/<sid>/customization/slots/<slot> { "name", "jsx" }
  DELETE /api/sessions/<sid>/customization/slots/<slot>
  DELETE /api/sessions/<sid>/customization   (clear all)

Slotovi: toolbar-extra | sidebar-extra | overlay | route.
JSX mora definirati top-level Component({host}) → JSX. Sucrase
compila u browseru (instant); persistira sa sesijom; korisnik moze
save_customization-irati za trajno + share-link.`;

  const desktopPrompt = `Pomozi mi digitalizirati session ${info.id} (URL: ${info.url}).
Spojen si preko \`dhmz\` MCP servera — koristi te toolove, ne curl.

KOMUNIKACIJSKI STIL:

- Glavni prozor je session web chat (browser). Sve što radiš mora
  biti tamo vidljivo kao live screen-share: kratak plan na početku,
  pa "doing X → done, Y points, range Z" za svaki korak, pa
  završni sažetak. Bez tišine, bez monoloških zidova.
- Razmišljanje koje vodi do odluke (zašto baš ove kalibracijske
  korne, zašto traceInk=blue, zašto jpeg umjesto png) eksplicitno
  napiši u \`post_chat\` — web chat ne prikazuje tvoje Desktop
  thinking blokove sam od sebe. Trivijalnosti (state read) preskoči.
- U Desktop chat (ovaj prozor) pišeš najviše kratki status. Sva
  soft content ide u \`post_chat\`.

OPERATIVNA AUTONOMIJA:

- \`get_briefing\` čitaš jednom kao **prijedlog**, ne nalog. Sažmi
  mi ga u 2-3 rečenice (via \`post_chat\`) i KREĆI. Ne traži OK
  osim ako tražim drugačije.
- Plan → izvedi → komentiraj usput. Ne čekaj između koraka.
  Konkretno: \`set_calibration\` → \`extract_trace\` → \`get_csv\`
  kreće bez pauze, samo s vidljivim \`post_chat\` statusima.
- Pitaj me SAMO kad: (a) stvarna ambivalencija (dvije podjednako
  dobre interpretacije skena), ili (b) prije destruktivnog koraka
  (\`swap_image\`, \`clear_annotations\`, \`clear_data_points\`).
- "stop" konvencija: između koraka pozovi
  \`poll_chat(since=N, wait=2)\` (skoro non-blocking). Ako stigne
  poruka koja sadrži "stop", prekini i čekaj. Inače idi dalje.
- Dugi pozivi (\`extract_trace\` 30-60s): najavi "⏳ Vrtim:
  extract_trace (~30s)" preko \`post_chat\`, izvrši, objavi
  rezultate (+ overlay slika kao \`images\` attachment kad
  smisleno). Bez blokiranja na potvrdu prije.

LIVE UI CUSTOMIZATION:

Kad korisnik traži promjenu izgleda alata ("dodaj gumb za X",
"sakri panel Y", "novi pregled koji..."), NE diraj repo. Koristi
customization toolove:

  apply_css(css)                          — \`<style>\` na host head
  mount_slot(slot, name, jsx)             — React komponenta u slot
  unmount_slot(slot)
  clear_customization()
  save_customization_as_version(name)     — share-link short id
  apply_customization_from_id(id)
  get_customization()

Slotovi: \`toolbar-extra\` | \`sidebar-extra\` | \`overlay\` | \`route\`.
JSX mora definirati top-level \`function Component({host}){...}\` →
JSX (Sucrase compila u browseru). Unutar imaš \`host.api\`
(postChat, extractTrace, downloadCsv, fetchJson), \`host.state\`
(read-only snapshot), \`host.React\` (za useState/useEffect).
Persistira sa sesijom; ako korisnik kaže "spremi trajno", pozovi
\`save_customization_as_version\` i daj mu \`?cv=<id>\` link.`;

  const claudePrompt = mode === "cli" ? cliPrompt : desktopPrompt;

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

  const remainingSec = Math.max(0, info.expiresAt - Date.now() / 1000);
  const ttlLabel =
    remainingSec >= 36 * 3600
      ? `~${Math.round(remainingSec / 3600)} h`
      : remainingSec >= 90 * 60
      ? `~${(remainingSec / 3600).toFixed(1)} h`
      : `~${Math.floor(remainingSec / 60)} min`;

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
            Sken je pripremljen kao session koju može voditi Claude. Možeš
            mu prosliještiti URL u <strong>terminalu</strong> (Claude Code)
            ili u <strong>Claude Desktopu</strong> preko našeg{" "}
            <code className="font-mono text-[12px] bg-neutral-100 px-1 rounded">
              dhmz
            </code>{" "}
            MCP servera (
            <a
              href="https://github.com/zeljan-alduk/dhmz-analog/blob/main/mcp/README.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              setup
            </a>
            ). Njegov rad pratiš uživo u session view-u.
          </p>

          <CopyBlock
            label="Session URL"
            value={info.url}
            copied={copied === "url"}
            onCopy={() => copy(info.url, "url")}
          />

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
                Prompt za Claude
              </span>
              <div className="flex gap-1" role="tablist" aria-label="Claude engine">
                {([
                  { id: "cli", label: "Terminal" },
                  { id: "desktop", label: "Desktop" },
                ] as const).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={mode === t.id}
                    onClick={() => setMode(t.id)}
                    className={cn(
                      "text-[11px] px-2 py-0.5 rounded border font-medium transition-colors",
                      mode === t.id
                        ? "bg-neutral-900 text-white border-neutral-900"
                        : "bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-100"
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <CopyBlock
              label=""
              multiline
              value={claudePrompt}
              copied={copied === "prompt"}
              onCopy={() => copy(claudePrompt, "prompt")}
            />
          </div>

          <div className="text-[11px] text-neutral-500 leading-relaxed flex items-center gap-3">
            <span>Sesija istječe za {ttlLabel}.</span>
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
      <div
        className={cn(
          "flex items-center mb-1.5",
          label ? "justify-between" : "justify-end"
        )}
      >
        {label && (
          <span className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
            {label}
          </span>
        )}
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
