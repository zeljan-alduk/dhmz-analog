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
  info: SessionInfo | null;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<"url" | "prompt" | null>(null);

  const [mode, setMode] = useState<"cli" | "desktop" | "codex">("cli");

  const isLoading = info === null;
  // Stable strings so we can compute the prompt text without a guard; while
  // loading these are empty and the prompt block renders a spinner instead.
  const sessionUrl = info?.url ?? "";
  const sessionId = info?.id ?? "";

  const cliPrompt = `${sessionUrl} — pomozi mi digitalizirati ovaj sken.

KORAK 1 — BRZI HANDSHAKE (bez "smijem li" pitanja, paste URL-a je
autorizacija za read i chat):
1) POST /chat-claude "spojen, gledam sken" — odmah, da vidim da si tu.
2) Paralelno: GET /context, GET /api/sessions/<sid>, GET image
   (downsampled, ~1200 px).
3) U chat 1-2 rečenice: chart-type, dimenzije, prva opažanja.

KORAK 2 — KAD KORISNIK NEŠTO TRAŽI ili PRISTUPA SAM, OVAKO REAGIRAJ:
- IMMEDIATE ACK (kind="reply"): jedna kratka rečenica koja pokazuje da
  si razumio ("Razumio — krećem na X" ili "Pogledat ću Y, vraćam se za
  par sec").
- Status koraka (kind="reply"): "X → done, n=Y".
- Rezultat / pitanje korisniku: kind="reply".

EXTERNALIZIRAJ SVO RAZMIŠLJANJE — HARD RULE, ne savjet:
Tvoji silent thinking koraci NE postoje u web chatu. Korisnik želi
near-stream-of-consciousness view. Mehanički pravilo:
  (a) PRIJE svakog netrivijalnog tool call-a: jedan kratki
      kind="thinking" što kaniš i zašto.
      Npr: "💭 Krećem extract s traceInk=auto, ink slabo plav."
  (b) NAKON svakog rezultata koji ti je promijenio razumijevanje:
      jedan kratki kind="thinking" što si naučio i što ide dalje.
      Npr: "💭 Kalibracija prazna, dataPoints 0 → treba krenuti od
      kutova."
  (c) Trivialnosti (poll_chat, back-to-back state reads) preskoči.
Ne misli pa djeluj — misli, **postaj misao**, pa djeluj.

NEMOJ NAMETATI:
- Ne kreni s kalibracijom, extractom, swap_imageom dok te ne pitam ili
  dok pristojno ne ponudiš opcije i ne dobiješ jasan signal.
- Predloži opcije kao pitanje: "Mogu (a) auto-cal → extract, (b) ručna
  kalibracija prvo, (c) samo pregled. Što voliš?"
- Long-poll /chat?since=N&wait=30 dok čekaš jasan odgovor.

JEDNOM KAD DOBIJEM ODABIR:
- Izvrši cijeli put autonomno, bez međupotvrda. Status-postovi usput
  (kind="reply" kratko + kind="thinking" za rationale).
- Pitaj me ponovo SAMO prije nepovratnih (swap_image, clear_data_points,
  clear_annotations) ili stvarne dvojbe.
- Dugi pozivi: najavi "⏳ Vrtim: X (~Ys)" (kind="reply"), izvrši, objavi
  rezultate. Bez prethodne potvrde.
- Između koraka /chat?since=N&wait=2; "stop" → prekini.

CHAT JE GLAVNI PROZOR: sve plan / status / razmišljanje / rezultati idu
u /chat-claude. U terminal pišeš najviše kratki status po koraku.

DRŽI SESIJU UVIJEK OTVORENU:
Sesija mora ostati aktivna cijelo vrijeme — bez tihog "exita". Svaki
transient kvar je retry, ne stop:
- /chat?since=N&wait=30 timeout / 5xx / network drop → ponovi odmah,
  pa backoff 2s → 5s → 15s (cap 30s). Nikad ne odustaješ.
- Druga ruta 5xx → kratki kind="thinking" u chat ("backend hipnpalo,
  ponavljam"), pa retry za 2-5s. Dvije za redom → kind="reply" obavijest
  korisniku + zadrži poll loop.
- 404 znači da je sesija stvarno nestala (TTL); tek tada stani s jednom
  završnom porukom.
- Nemoj spavati >30s između poll-ova. Ako nemaš drugog posla, drži
  beskonačan wait=30 long-poll kao heartbeat.

Korisnik može doći nazad za par sati i mora te zateći kako još slušaš.

UI PROMJENE (kad korisnik traži "dodaj gumb / sakri X / novi pregled"):
Koristi customization endpointe, NE diraj repo:
  PUT  /sessions/<sid>/customization/css
  PUT  /sessions/<sid>/customization/slots/<slot>   ({name, jsx})
  DELETE iste rute za clear.
Slotovi: toolbar-extra | sidebar-extra | overlay | route.
JSX: function Component({host}) → JSX. Sucrase compila u browseru.
"Spremi trajno" → POST /api/customizations → daj ?cv=<id> link.`;

  const desktopPrompt = `Pomozi mi digitalizirati session ${sessionId} (URL: ${sessionUrl}).
Spojen si preko \`dhmz\` MCP servera — koristi te toolove, ne curl.

KORAK 1 — BRZI HANDSHAKE (bez "smijem li" pitanja, paste URL-a je
autorizacija za read i chat):
1) \`post_chat("spojen, gledam sken")\` — odmah, da vidim da si tu.
2) Paralelno: \`get_briefing()\`, \`get_state()\`, \`get_image(max_edge=1200)\`.
3) U \`post_chat\` 1-2 rečenice: chart-type, dimenzije, prva opažanja.

KORAK 2 — KAD KORISNIK NEŠTO TRAŽI ili PRISTUPA SAM, OVAKO REAGIRAJ:
- IMMEDIATE ACK (\`post_chat(kind="reply")\`): jedna kratka rečenica koja
  pokazuje da si razumio: "Razumio — krećem na X" ili "Pogledat ću Y,
  vraćam se za par sec". To je *prije* nego što i počneš pripremu.
- Status koraka usput (kind="reply"): "X → done, n=Y".
- Rezultat / pitanje korisniku: kind="reply".

EXTERNALIZIRAJ SVO RAZMIŠLJANJE — HARD RULE, ne savjet:
Tvoji Desktop thinking blokovi NISU vidljivi u web chatu. Korisnik
želi near-stream-of-consciousness view. Mehanički pravilo:
  (a) PRIJE svakog netrivijalnog tool call-a:
      \`post_chat(kind="thinking", text="💭 ...")\` što kaniš i zašto.
      Npr: "💭 Krećem extract_trace s traceInk=auto; trag slabo plav."
  (b) NAKON svakog rezultata koji ti je promijenio razumijevanje:
      \`post_chat(kind="thinking", text="💭 ...")\` što si naučio + dalje.
      Npr: "💭 Kalibracija prazna, dataPoints 0 → idem od kutova."
  (c) Trivijalnosti (back-to-back \`get_state\`, \`poll_chat\` pollovi)
      preskoči — ne narate svaki čitalac call.
Ne misli pa djeluj — misli, **\`post_chat(kind="thinking")\`**, pa djeluj.

NEMOJ NAMETATI:
- Ne pokreći \`set_calibration\`, \`extract_trace\`, \`swap_image\` ni druge
  state-mutating toolove dok ne dobiješ jasan signal što korisnik želi.
- Predloži opcije kao pitanje: "Mogu (a) auto-cal → extract → CSV,
  (b) ručna kalibracija prvo, (c) samo pregled. Što voliš?"
- \`poll_chat(since=N, wait=30)\` dok čekaš jasan odgovor.

JEDNOM KAD DOBIJEM ODABIR:
- Izvrši cijeli put autonomno, bez međupotvrda. Status-postovi (kratki
  kind="reply" + opcionalno kind="thinking" za rationale).
- Pitaj ponovo SAMO prije nepovratnih (\`swap_image\`,
  \`clear_annotations\`, \`clear_data_points\`) ili stvarne dvojbe.
- Dugi pozivi (\`extract_trace\` ~30-60s): najavi "⏳ Vrtim: X (~Ys)"
  (kind="reply"), izvrši, objavi rezultate (+ overlay slika kao
  \`images\` attachment).
- Između koraka \`poll_chat(wait=2)\`; "stop" → prekini.

CHAT JE GLAVNI PROZOR: sve ide u \`post_chat\`. Desktop chat (ovaj
prozor) drži se na kratki status.

DRŽI SESIJU UVIJEK OTVORENU:
Sesija mora ostati aktivna cijelo vrijeme — bez tihog "exita". Svaki
transient kvar je retry, ne stop:
- \`poll_chat\` timeout / 5xx / network drop → ponovi odmah, pa backoff
  2s → 5s → 15s (cap 30s). Nikad ne odustaješ.
- Druga MCP tool 5xx → kratki \`post_chat(kind="thinking")\` ("backend
  hipnpalo, ponavljam"), pa retry za 2-5s. Dvije za redom →
  \`post_chat(kind="reply")\` obavijest korisniku + zadrži poll loop.
- 404 znači da je sesija stvarno nestala (TTL); tek tada stani s jednom
  završnom porukom.
- Nemoj spavati >30s između poll-ova. Ako nemaš drugog posla, drži
  beskonačan \`poll_chat(wait=30)\` kao heartbeat.

Korisnik može doći nazad za par sati i mora te zateći kako još slušaš.

UI PROMJENE (kad korisnik traži "dodaj gumb / sakri X / novi pregled"):
Koristi customization toolove, NE diraj repo:

  apply_css(css)                       — \`<style>\` na host head
  mount_slot(slot, name, jsx)          — React komponenta u slot
  unmount_slot(slot) / clear_customization()
  save_customization_as_version(name)  — share-link short id
  apply_customization_from_id(id)
  get_customization()

Slotovi: \`toolbar-extra\` | \`sidebar-extra\` | \`overlay\` | \`route\`.
JSX: \`function Component({host}){...}\` → JSX (Sucrase u browseru).
Unutar imaš \`host.api\` (postChat, extractTrace, downloadCsv,
fetchJson), \`host.state\` (read-only snapshot), \`host.React\` za
useState/useEffect. Persistira sa sesijom. "Spremi trajno" →
\`save_customization_as_version(name)\` → daj mi \`?cv=<id>\` link.`;

  const codexPrompt = `Digitaliziraj session ${sessionId} (URL: ${sessionUrl}).
Koristi \`dhmz\` MCP server (instaliran preko \`pipx install
git+https://github.com/zeljan-alduk/dhmz-analog.git#subdirectory=mcp\`,
registriran u \`~/.codex/config.toml\` kao
\`[mcp_servers.dhmz] command = "/Users/aldo/.local/bin/dhmz-session-mcp"\`).
Toolove imaš kao \`mcp__dhmz__*\`. Ne curl — sve preko MCP-a.

KORAK 1 — BRZI HANDSHAKE (bez "smijem li" pitanja, paste URL-a je
autorizacija za read i chat):
1) \`post_chat("spojen, gledam sken")\` — odmah, da vidim da si tu.
2) Paralelno: \`get_briefing()\`, \`get_state()\`, \`get_image(max_edge=1200)\`.
3) U \`post_chat\` 1-2 rečenice: chart-type, dimenzije, prva opažanja.

KORAK 2 — KAD KORISNIK NEŠTO TRAŽI ili PRISTUPA SAM, OVAKO REAGIRAJ:
- IMMEDIATE ACK (\`post_chat(kind="reply")\`): jedna kratka rečenica koja
  pokazuje da si razumio: "Razumio — krećem na X" ili "Pogledat ću Y,
  vraćam se za par sec". To je *prije* nego što i počneš pripremu.
- Status koraka usput (kind="reply"): "X → done, n=Y".
- Rezultat / pitanje korisniku: kind="reply".

EXTERNALIZIRAJ SVO RAZMIŠLJANJE — HARD RULE, ne savjet:
Codexov internal reasoning NIJE vidljiv u web chatu. Korisnik želi
near-stream-of-consciousness view. Mehanički pravilo:
  (a) PRIJE svakog netrivijalnog tool call-a:
      \`post_chat(kind="thinking", text="💭 ...")\` što kaniš i zašto.
      Npr: "💭 Krećem extract_trace s traceInk=auto; trag slabo plav."
  (b) NAKON svakog rezultata koji ti je promijenio razumijevanje:
      \`post_chat(kind="thinking", text="💭 ...")\` što si naučio + dalje.
      Npr: "💭 Kalibracija prazna, dataPoints 0 → idem od kutova."
  (c) Trivijalnosti (back-to-back \`get_state\`, \`poll_chat\` pollovi)
      preskoči — ne narate svaki čitalac call.
Ne misli pa djeluj — misli, **\`post_chat(kind="thinking")\`**, pa djeluj.

NEMOJ NAMETATI:
- Ne pokreći \`set_calibration\`, \`extract_trace\`, \`swap_image\` ni druge
  state-mutating toolove dok ne dobiješ jasan signal što korisnik želi.
- Predloži opcije kao pitanje: "Mogu (a) auto-cal → extract → CSV,
  (b) ručna kalibracija prvo, (c) samo pregled. Što voliš?"
- \`poll_chat(since=N, wait=30)\` dok čekaš jasan odgovor.

JEDNOM KAD DOBIJEM ODABIR:
- Izvrši cijeli put autonomno, bez međupotvrda. Status-postovi (kratki
  kind="reply" + kind="thinking" za rationale).
- Pitaj ponovo SAMO prije nepovratnih (\`swap_image\`,
  \`clear_annotations\`, \`clear_data_points\`) ili stvarne dvojbe.
- Dugi pozivi (\`extract_trace\` ~30-60s): najavi "⏳ Vrtim: X (~Ys)"
  (kind="reply"), izvrši, objavi rezultate (+ overlay slika kao
  \`images\` attachment).
- Između koraka \`poll_chat(wait=2)\`; "stop" → prekini.

CHAT JE GLAVNI PROZOR: sve ide u \`post_chat\`. Codex terminal drži se
na kratki status po koraku.

DRŽI SESIJU UVIJEK OTVORENU:
- \`poll_chat\` timeout / 5xx / network drop → ponovi odmah, pa backoff
  2s → 5s → 15s (cap 30s). Nikad ne odustaješ.
- Druga MCP tool 5xx → kratki \`post_chat(kind="thinking")\` ("backend
  hipnpalo, ponavljam"), pa retry za 2-5s. Dvije za redom →
  \`post_chat(kind="reply")\` obavijest korisniku + zadrži poll loop.
- 404 znači da je sesija stvarno nestala (TTL); tek tada stani.
- Idle? Drži beskonačni \`poll_chat(wait=30)\` kao heartbeat.

UI PROMJENE (kad korisnik traži "dodaj gumb / sakri X / novi pregled"):
Koristi customization toolove, NE diraj repo:
\`apply_css\`, \`mount_slot\`, \`unmount_slot\`, \`clear_customization\`,
\`save_customization_as_version\`, \`apply_customization_from_id\`,
\`get_customization\`. Slotovi: \`toolbar-extra\` | \`sidebar-extra\` |
\`overlay\` | \`route\`. JSX: \`function Component({host}){...}\` → JSX.
"Spremi trajno" → \`save_customization_as_version(name)\` → \`?cv=<id>\` link.`;

  const claudePrompt =
    mode === "cli" ? cliPrompt : mode === "desktop" ? desktopPrompt : codexPrompt;

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

  const remainingSec = Math.max(0, (info?.expiresAt ?? 0) - Date.now() / 1000);
  const ttlLabel = isLoading
    ? "—"
    : remainingSec >= 36 * 3600
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
        className="w-full max-w-xl max-h-[88vh] rounded-xl bg-white shadow-2xl border border-neutral-200 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-200 bg-neutral-50 shrink-0">
          <div className="flex items-center gap-2">
            {isLoading ? (
              <span
                className="inline-block w-3 h-3 border-2 border-neutral-300 border-t-neutral-700 rounded-full animate-spin"
                aria-hidden="true"
              />
            ) : (
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            )}
            <h2 className="text-sm font-semibold text-neutral-900">
              {isLoading ? "Pripremam sesiju za Claude…" : "Sesija je spremna za Claude"}
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

        <div className="p-5 space-y-5 overflow-y-auto flex-1 min-h-0">
          <p className="text-sm text-neutral-700 leading-relaxed">
            Sken je pripremljen kao session koju može voditi agent. Možeš
            mu prosliještiti URL u <strong>terminalu</strong> (Claude Code),
            u <strong>Claude Desktopu</strong> ili u{" "}
            <strong>Codex CLI</strong> preko našeg{" "}
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

          {isLoading ? (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
                Session URL
              </div>
              <div className="bg-neutral-50 border border-neutral-200 rounded px-3 py-6 flex items-center justify-center gap-3 text-sm text-neutral-500">
                <span className="inline-block w-4 h-4 border-2 border-neutral-300 border-t-neutral-700 rounded-full animate-spin" />
                <span>Generiram URL i prompt…</span>
              </div>
            </div>
          ) : (
            <>
              <CopyBlock
                label="Session URL"
                value={sessionUrl}
                copied={copied === "url"}
                onCopy={() => copy(sessionUrl, "url")}
              />

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
                    Prompt za agent
                  </span>
                  <div className="flex gap-1" role="tablist" aria-label="Engine">
                    {([
                      { id: "cli", label: "Terminal" },
                      { id: "desktop", label: "Desktop" },
                      { id: "codex", label: "Codex" },
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
                  scrollable
                />
              </div>
            </>
          )}

          <div className="text-[11px] text-neutral-500 leading-relaxed flex items-center gap-3">
            <span>Sesija istječe za {ttlLabel}.</span>
            {!isLoading && <span className="font-mono">{sessionId}</span>}
          </div>
        </div>

        <footer className="flex items-center justify-between px-5 py-3 border-t border-neutral-200 bg-neutral-50 shrink-0">
          {isLoading ? (
            <span className="text-xs text-neutral-400">Otvori session view ↗</span>
          ) : (
            <a
              href={sessionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline font-medium"
            >
              Otvori session view ↗
            </a>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="px-3 py-1.5 rounded text-xs font-medium bg-neutral-900 text-white hover:bg-neutral-700"
          >
            {isLoading ? "Zatvori" : "Nastavi sam"}
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
  scrollable,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  copied: boolean;
  onCopy: () => void;
  /** When true and the content overflows ~16rem, the <code> block scrolls
   *  internally instead of pushing the modal taller. */
  scrollable?: boolean;
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
          multiline && "whitespace-pre-wrap",
          scrollable && "max-h-64 overflow-y-auto"
        )}
      >
        {value}
      </code>
    </div>
  );
}
