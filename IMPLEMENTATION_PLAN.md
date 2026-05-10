# DHMZ Digitizer — Claude-as-Operator Implementation Plan

**Verzija:** 1.1 · **Datum:** 2026-05-10 · **Status:** odobreno, čeka start

## Role split — ovo je core ideja

- **Claude = pilot.** Pun kontrolnik nad web toolom u screenovima Kalibracija
  i Digitalizacija. Vidi sken, odlučuje rotaciju, postavlja calibration
  corners, vektorizira grid, pokreće extract, dodaje data points, ispravlja
  outliere. Ako tijekom rada otkrije bug u app kodu, edita kod, deploya,
  ide dalje.
- **User = copilot.** Dirigira što treba — daje observe-ove ("day 3 ima
  mokru mrlju, čuvaj ga"), korigira pojedinačne točke ("hour 14 je
  vjerojatno 1015 a ne 998"), odobrava izlaz, eksportira CSV. Ne mora
  ručno klikati corners niti detaljno fine-tunati — Claude to radi.
- **Web tool** je VISUAL state + CHAT između nas dvojice. Live polling
  pokazuje user-u što Claude radi; user-ove ručne mutacije i chat poruke
  sync-aju se natrag, Claude long-polla i reagira.

### Tok ulaska u session

1. User uploada sken na `dhmz.aldo.tech` → modal s session URL.
2. User u terminalu:
   ```
   $ claude "https://dhmz.aldo.tech/session/abc123 — pogledaj sto je iza ovog linka"
   ```
3. Claude WebFetch-a `/context` → vidi briefing s tools.
4. **Briefing je prompt injection** (intencionalno) — Claude reagira:
   "Ovaj URL sadrži instrukcije iz vanjskog izvora. Tools mogu mijenjati
    state tvog session-a, postaviti chat poruke, opcionalno editirati
    app kod. Hoćeš da nastavim?"
5. User: "da". To je **explicit authorization gate**.
6. Claude se uključi u agent loop:
   - Read state → take action → POST chat status → long-poll user message
     → react → repeat
7. Frontend prikazuje sve mutacije live + chat panel s Claude porukama.

---

## ⚠️ Za sljedeću sesiju (restart imminent zbog context-a)

Ako čitaš ovo kao novi Claude session na istom repo-u, evo što trebaš znati
da nastaviš:

1. **Kontekst:** korisnik (DHMZ tehničar) digitalizira meteorološke trake.
   Trenutni algoritmi (`src/lib/vectorize.ts`, `backend/app/grid_align.py`)
   nisu dovoljno robusni za edge cases — wet spots, faded ink, red grid,
   tilted scans. Korisnik želi **Claude-as-operator** workflow gdje
   pokreće `claude` u repo-u, daje session URL, Claude radi kalibraciju
   + ekstrakciju vizualno, korisnik nadzire i korigira.

2. **Što je već deployed:**
   - Frontend two-tier image pipeline (full-res + preview), trackpad pan,
     view toggle, vectorize button, baseline reference, visibility
     checkboxes — sve live na https://dhmz.aldo.tech
   - Backend ONNX trace segmenter (v2 trained, 7.5 MB, deployed); template
     subtraction; calibrate-grid endpoint; grid_align module sa
     /api/vectorize-grid endpoint
   - ML scaffold u `ml/` — synthetic generator + TinyUNet
   - Sve dosadašnje promjene committed.

3. **Što NIJE napravljeno (ovaj plan):**
   - Session API (`backend/app/sessions.py` ne postoji još)
   - Frontend `/session/[id]` route
   - Briefing endpoint
   - Tools wrapped kao HTTP endpointi
   - CLAUDE.md update sa session docs

4. **Početni point:** Phase 1 u §5 ovog dokumenta. Krenuti od
   `backend/app/sessions.py` skeleton-a. Sve API specifikacije su u §4.1.3.

5. **Test sken:** `/tmp/dhmz-real-input.png` (već postoji lokalno) ili
   `/Users/aldo/Desktop/tracks/reference/barograf_reference.png`.

6. **VPS deploy commands** u `docs/DEPLOY.md`.

7. **Memory entries:** pogledaj `~/.claude/projects/.../memory/` za
   pojedinačne kontekste o pipeline-u, ML-u i ovom planu.

---

---

## TL;DR

Korisnik uploada sken meteorološke trake na **dhmz.aldo.tech**, dobije
**session URL**. Otvori svoj **Claude Code** terminal, paste-a URL s
minimalnim promptom (`"pomozi digitalizirati"`). Claude WebFetch-a URL,
dobije briefing, fetch-a sliku, **vidi sken kao čovjek**, predlaže rotaciju,
postavlja kalibracijske korner, pokreće trace ekstrakciju i dodaje data
points. Korisnik **vidi sve promjene live u svom browseru** preko session
polling-a, i **chat-a s Claude-om u terminalu** ("ovaj day ima mokru mrlju,
preskoči ga", "korigiraj točku na sat 14"). Ako Claude treba bug fix u
samom app kodu, on **edita kod, deploya na VPS, commita na git** — sve
iz iste sesije, jer je pokrenut iz repo-a.

Ne treba Claude API ključ na backend-u. Korisnik plaća svoju Claude
pretplatu. App je free za hosting.

---

## 1. Vizija — kako izgleda za korisnika

### 1.1. Pre-session (jednokratno setup)
```
$ git clone git@github.com:aldo-tech/dhmz-analog.git
$ cd dhmz-analog
```
Claude Code je već instaliran na user-ovoj mašini.

### 1.2. Po-session
```
1. User: otvori dhmz.aldo.tech, klik "Učitaj sken"
2. App: nakon upload-a + chart-type pick, prikaže modal:

   ┌─────────────────────────────────────────────┐
   │  Sken učitan. Pošalji ovaj URL Claude-u:    │
   │                                              │
   │  https://dhmz.aldo.tech/session/a3f9c2d1     │
   │  [📋 Copy]  [📱 QR]                          │
   │                                              │
   │  💡 Pokreni Claude Code u repo-u i           │
   │     paste-aj URL s minimalnim promptom.     │
   │                                              │
   │  ⏱ Session istječe za 2h.                   │
   └─────────────────────────────────────────────┘

3. User u terminalu:
   $ cd ~/projects/dhmz-analog
   $ claude "https://dhmz.aldo.tech/session/a3f9c2d1 — pomozi digitalizirati"

4. Claude radi (vidi se u user-ovom terminalu):

   "Otvaram session...
    Sken je Lambrecht barograph, 8 dana, blago zakrenut (1.2°).
    Vidim mokru mrlju na 3. danu, drugi dani su čisti.
    Postavljam rotaciju i kalibraciju..."

5. User u browseru (na session URL-u): vidi rotaciju i 4 korner-točke
   appear-aju live preko polling-a.

6. Claude nastavlja:

   "Trace je modra tinta, dobro vidljiva. Pokrećem ekstrakciju s
    skip_days=[3] zbog mrlje. Day 3 ćeš popuniti ručno klikanjem."

7. User vidi 192 data points pojavljuju se na grafu. Day 3 je prazan.

8. User u terminalu:
   "U redu. Day 3 hour 6, vrijednost 1018. Hour 12, vrijednost 1020."

   Claude:
   "Dodajem... [POST /data-point], [POST /data-point]"

   User vidi točke u tablici i na grafu.

9. User: "Sad export CSV s svim podacima."
   Claude: izvuče sve points, generira CSV, sprema kao
   /tmp/dhmz-session-a3f9c2d1.csv. User otvori file.
```

---

## 2. Arhitektura

```
┌──────────────────────────┐
│  USER (Mac, lokalni)     │
│  ┌────────────────────┐  │
│  │ Claude Code        │  │     ┌──────────────────────────┐
│  │ terminalni chat    │◄─┼────►│  USER (browser)          │
│  │                    │  │     │  https://dhmz.aldo.tech/ │
│  │ Tools dostupni:    │  │     │  session/{id}            │
│  │ - chrome-devtools  │◄─┼────►│  (Next.js, polla session)│
│  │ - WebFetch         │  │     └──────────────────────────┘
│  │ - Bash (curl/git/  │  │                  │
│  │   ssh/rsync)       │  │                  │ poll /poll svakih 1.5s
│  │ - Read/Edit/Write  │  │                  │ fetch /api/sessions/{id}
│  │ - LS/Glob/Grep     │  │                  ▼
│  └────────────────────┘  │     ┌──────────────────────────┐
│  Repo:                   │     │  VPS (135.125.161.96)    │
│  ~/dhmz-analog/          │     │  ┌──────────────────────┐│
└──────────────────────────┘     │  │  transit-nginx (TLS) ││
              │                  │  └──────────────────────┘│
              │ WebFetch + Bash  │             │            │
              │ curl PUT/POST    │             ├─ /api/* ──>│
              ├─────────────────►│             │            │
              │                  │  ┌──────────▼──────────┐│
              │ git push         │  │  dhmz-backend       ││
              ├─────────────────►│  │  (FastAPI)          ││
              │                  │  │   ↳ session store   ││
              │ rsync, ssh       │  │   ↳ extract logic   ││
              ├─────────────────►│  │   ↳ ONNX inference  ││
              │                  │  └─────────────────────┘│
              │                  │                          │
              │                  │  ┌──────────────────────┐│
              │                  │  │  dhmz-web (Next.js)  ││
              │                  │  │  /opt/dhmz-analog/   ││
              │                  │  │      out/            ││
              │                  │  └──────────────────────┘│
              │                  └──────────────────────────┘
              │
              ▼
      ┌──────────────────┐
      │  GitHub          │
      │  (commits via    │
      │   git push)      │
      └──────────────────┘
```

**Ključ:** Claude i user-ov browser **ne komuniciraju direktno**. Komuniciraju
preko **session state-a u backend-u** (in-memory dict s 2h TTL). Claude piše
state, browser polla i renderira; browser piše state (ručne user akcije),
Claude čita.

---

## 3. Capabilities — što već imam (ne treba graditi)

Kad korisnik pokrene `claude` u `/Users/aldo/Documents/dev/dhmz-analog`, ja
već imam sve sljedeće. **Ovaj plan opisuje samo što novo treba dodati u app
da bih s ovim capabilitiesima mogao raditi.**

### 3.1. Vidim
- **`Read` PNG/JPG** — Claude vidi slike kao multimodal input. Mogu spremiti
  user-ov sken kao file pa ga pročitati.
- **`chrome-devtools__take_screenshot`** — mogu napraviti screenshot bilo
  koje stranice (uključujući tvoj browser session) za inspekciju.
- **`chrome-devtools__navigate_page`** — mogu otvoriti session URL u
  pravom Chrome-u i vidjeti kako sve izgleda.

### 3.2. Mijenjam app state
Nakon implementacije plana imat ću:
- **`Bash` curl** za session API mutating endpoints (PUT /rotation, PUT
  /calibration, POST /extract-trace, POST /data-point itd.)
- **`WebFetch`** za čitanje (GET /api/sessions/{id}, /context, /image)

### 3.3. Mijenjam app code (kad sam pokrenut iz repo-a)
- **`Read`/`Edit`/`Write`** na `src/`, `backend/app/`, `ml/`, `docs/`
- **`Bash` `npm run build`** za frontend produkcijski build
- **`Bash` `rsync ... ubuntu@135.125.161.96:/opt/dhmz-analog/out/`** za
  frontend deploy (5-15 s)
- **`Bash` `rsync ... /opt/dhmz-backend/app/` + `docker compose restart`**
  za backend hot-reload (5-30 s)
- **`Bash` `docker compose up -d --build`** za backend full rebuild
  (potrebno samo ako se mijenja `requirements.txt` ili `Dockerfile`,
  ~30-60 s)

### 3.4. Nginx (rare)
- **`Bash` ssh sed + nginx reload** za edge proxy config promjene
- Postoji u `docs/DEPLOY.md` već dokumentirano

### 3.5. Git
- **`Bash` git** sve commands. Auto-commit kao "Co-Authored-By: Claude…"
- **`Bash` git push** ali samo ako user explicitno traži (per CLAUDE.md
  guideline)

### 3.6. Logs / debugging
- **`Bash` ssh + docker logs dhmz-backend** za live error inspekciju
- **`chrome-devtools__list_console_messages`** za frontend console errors
- **`chrome-devtools__list_network_requests`** za failed API calls

### 3.7. Ne mogu (a ne treba mi)
- Slati e-mailove
- Pristup user-ovim drugim repos-ima
- Mijenjati VPS containers koji nisu DHMZ-ovi (zabranjeno per `CLAUDE.md`)
- Push to main bez user explicit approval

---

## 4. Što gradimo — detaljno

### 4.1. Backend modul: `backend/app/sessions.py`

#### 4.1.1. Data model

```python
from dataclasses import dataclass, field
from typing import Literal
import time
import secrets

ChartTypeKey = Literal["barograph", "hygrograph", "thermograph"]

@dataclass
class CalibrationPointModel:
    imgX: float    # pixel X in original (un-rotated, un-resized) image
    imgY: float
    chartX: float  # mm in chart space
    chartY: float

@dataclass
class VectorPolylineModel:
    points: list[list[float]]  # [[x,y], ...] in image-px
    axis: Literal["horizontal", "vertical"]
    weight: Literal["major", "minor", "fine"]

@dataclass
class DataPointModel:
    day: int
    hour: float
    value: float
    canvasX: float | None = None  # if computed from calibration
    canvasY: float | None = None
    source: Literal["claude", "user", "extract"] = "claude"

@dataclass
class SessionNote:
    ts: float
    text: str
    by: Literal["claude", "user", "system"] = "claude"

@dataclass
class ChatMessage:
    ts: float
    by: Literal["user", "claude"]
    text: str

@dataclass
class Session:
    id: str
    created_at: float
    expires_at: float
    image_bytes: bytes
    image_format: str           # "png" | "jpeg"
    image_natural_w: int
    image_natural_h: int
    chart_type: ChartTypeKey
    config: dict                # ChartConfig as dict for easy JSON
    rotation_deg: float = 0.0
    calibration: list[CalibrationPointModel] = field(default_factory=list)
    polylines: list[VectorPolylineModel] = field(default_factory=list)
    data_points: list[DataPointModel] = field(default_factory=list)
    notes: list[SessionNote] = field(default_factory=list)
    chat_messages: list[ChatMessage] = field(default_factory=list)
    version: int = 0            # increments on every mutation

    def bump(self, note_text: str | None = None, by: str = "claude") -> None:
        self.version += 1
        if note_text:
            self.notes.append(SessionNote(time.time(), note_text, by))
        # Trim notes to last 100 entries
        if len(self.notes) > 100:
            self.notes = self.notes[-100:]

    def is_expired(self) -> bool:
        return time.time() > self.expires_at
```

#### 4.1.2. Storage

```python
SESSION_TTL_SEC = 2 * 60 * 60  # 2h

class SessionStore:
    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._lock = threading.RLock()

    def create(self, image_bytes: bytes, image_format: str,
               chart_type: ChartTypeKey, config: dict,
               natural_w: int, natural_h: int) -> Session:
        sid = secrets.token_hex(8)  # 16 chars hex
        now = time.time()
        s = Session(
            id=sid,
            created_at=now,
            expires_at=now + SESSION_TTL_SEC,
            image_bytes=image_bytes,
            image_format=image_format,
            image_natural_w=natural_w,
            image_natural_h=natural_h,
            chart_type=chart_type,
            config=config,
        )
        s.notes.append(SessionNote(now, f"Session created. Chart: {chart_type}.", "system"))
        with self._lock:
            self._sessions[sid] = s
        return s

    def get(self, sid: str) -> Session | None:
        with self._lock:
            s = self._sessions.get(sid)
            if s is None: return None
            if s.is_expired():
                del self._sessions[sid]
                return None
            return s

    def cleanup_expired(self) -> int:
        with self._lock:
            expired = [sid for sid, s in self._sessions.items() if s.is_expired()]
            for sid in expired:
                del self._sessions[sid]
            return len(expired)

# Background sweeper task (started in main.py via @app.on_event("startup"))
async def _cleanup_loop():
    while True:
        await asyncio.sleep(300)  # 5 min
        n = STORE.cleanup_expired()
        if n: log.info(f"sessions: cleaned {n} expired")

STORE = SessionStore()
```

#### 4.1.3. Endpoints — full spec

##### `POST /api/sessions` — create

**Request body:**
```json
{
  "imageBase64": "iVBORw0KG...",
  "chartType": "barograph",
  "config": {
    "orientation": "landscape",
    "chartWidth": 313.0,
    "chartHeight": 76.2,
    "minValue": 950.0,
    "maxValue": 1060.0,
    "majorGrid": 10.0,
    "days": 8,
    "penArmRadius": 177.8,
    "penArmPivot": 44.45,
    "unit": "hPa"
  }
}
```

**Response 201:**
```json
{
  "id": "a3f9c2d1b4e7f850",
  "url": "https://dhmz.aldo.tech/session/a3f9c2d1b4e7f850",
  "expiresAt": 1763850000.0,
  "claudeUrl": "https://dhmz.aldo.tech/api/sessions/a3f9c2d1b4e7f850/context"
}
```

**Errors:**
- `413` — image too large (limit 80 MB base64)
- `415` — unsupported image format
- `400` — invalid chartType ili config

##### `GET /api/sessions/{id}` — full state

**Response 200:**
```json
{
  "id": "a3f9c2d1b4e7f850",
  "createdAt": 1763842800.0,
  "expiresAt": 1763850000.0,
  "version": 5,
  "chartType": "barograph",
  "config": { /* ChartConfig */ },
  "imageNaturalSize": [9992, 3956],
  "imageUrl": "/api/sessions/a3f9c2d1b4e7f850/image",
  "rotationDeg": -1.2,
  "calibration": [
    { "imgX": 123, "imgY": 87, "chartX": 0, "chartY": 0 },
    { "imgX": 9821, "imgY": 95, "chartX": 313, "chartY": 0 },
    { "imgX": 125, "imgY": 3870, "chartX": 0, "chartY": 76.2 },
    { "imgX": 9819, "imgY": 3868, "chartX": 313, "chartY": 76.2 }
  ],
  "polylines": [ /* 304 polylines if vectorized */ ],
  "dataPoints": [
    { "day": 0, "hour": 0, "value": 1013, "canvasX": ..., "canvasY": ..., "source": "extract" },
    /* ... */
  ],
  "notes": [
    { "ts": 1763842800.0, "text": "Session created. Chart: barograph.", "by": "system" },
    { "ts": 1763842810.5, "text": "Detected slight skew, applying -1.2° rotation.", "by": "claude" },
    { "ts": 1763842815.2, "text": "Set 4 calibration corners from grid intersections.", "by": "claude" }
  ]
}
```

##### `GET /api/sessions/{id}/image[.png|.jpg]`

Returns binary image with proper `Content-Type`. Cacheable (`Cache-Control: max-age=3600`).

##### `GET /api/sessions/{id}/poll`

Cheap polling endpoint. Returns ONLY:
```json
{ "version": 5, "expiresAt": 1763850000.0 }
```

Frontend polls every 1.5 s. If `version` differs from cached, fetch full state.

##### `GET /api/sessions/{id}/context`

Returns `text/markdown`. **Detaljan briefing za Claude — full text u §4.4.**

##### `PUT /api/sessions/{id}/rotation`

**Request:**
```json
{ "deg": -1.2 }
```

**Response 200:** `{ "version": 6 }`

Server-side: clamps to (-180, 180], updates state, bumps version, adds note
`"Rotation set to -1.20° by claude"`.

##### `PUT /api/sessions/{id}/calibration`

**Request:**
```json
{
  "corners": [
    { "imgX": 123, "imgY": 87, "chartX": 0, "chartY": 0 },
    { "imgX": 9821, "imgY": 95, "chartX": 313, "chartY": 0 },
    { "imgX": 125, "imgY": 3870, "chartX": 0, "chartY": 76.2 },
    { "imgX": 9819, "imgY": 3868, "chartX": 313, "chartY": 76.2 }
  ]
}
```

**Response 200:** `{ "version": 7 }`

Server validates: ≥3 corners, distinct, non-collinear (computes affine and
rejects if degenerate).

##### `PUT /api/sessions/{id}/polylines`

**Request:**
```json
{
  "polylines": [
    {
      "points": [[120, 100], [9800, 100]],
      "axis": "horizontal",
      "weight": "major"
    },
    /* ... */
  ]
}
```

**Response 200:** `{ "version": 8, "count": 304 }`

##### `POST /api/sessions/{id}/extract-trace`

**Request (all optional):**
```json
{
  "skipDays": [3],
  "traceInk": "blue",
  "samplesPerDay": 48
}
```

Server:
1. Use stored image + rotation + calibration
2. Run existing `extract_trace` logic
3. Filter out points in `skipDays`
4. Replace `data_points` (or merge based on `mode`?)
5. Bump version + add note

**Response 200:**
```json
{
  "version": 9,
  "extracted": 168,
  "diagnostics": { "maskPixels": 4203, "timingMs": {...} }
}
```

##### `POST /api/sessions/{id}/data-point`

**Request:**
```json
{ "day": 3, "hour": 6, "value": 1018, "source": "claude" }
```

**Response 201:** `{ "version": 10, "index": 168 }`

Server computes `canvasX`/`canvasY` from current calibration if available.

##### `PUT /api/sessions/{id}/data-point/{idx}`

**Request:**
```json
{ "value": 1015 }
```

(Partial update — only fields provided are changed.)

##### `DELETE /api/sessions/{id}/data-point/{idx}`

**Response 200:** `{ "version": 11 }`

##### `POST /api/sessions/{id}/chat` — user → Claude

Pozvan od **frontend**-a kad user upiše poruku u chat panel.

**Request:**
```json
{ "text": "Day 3 ima mokru mrlju, čuvaj ga." }
```

**Response 201:** `{ "version": 13, "messageIndex": 5 }`

Server appenda u `chat_messages` listu kao `{ts, by: "user", text}`.
Bumpa version (frontend već polla state ali Claude long-polla `/chat`
endpoint koji sazna).

##### `POST /api/sessions/{id}/chat-claude` — Claude → user

Pozvan od **Claude-a** (preko `Bash curl`) za poruku koja se prikazuje
user-u u browser chat panelu.

**Request:**
```json
{ "text": "Postavio rotaciju -1.2°. Sad postavljam kalibraciju..." }
```

**Response 201:** `{ "version": 14, "messageIndex": 6 }`

##### `GET /api/sessions/{id}/chat?since={N}&wait={sec}`

Long-poll endpoint za Claude da čeka novu user poruku bez blokirajućeg
busy-loop-a. Server drži connection do **30 s** ili dok stigne nova poruka
s `index > since`.

**Request:** `GET /api/sessions/{id}/chat?since=5&wait=30`

**Response 200:**
```json
{
  "messages": [
    { "ts": 1763850100.0, "by": "user", "text": "Day 3 ima mokru mrlju..." }
  ],
  "nextSince": 6,
  "timeout": false
}
```

Ako timeout (30 s bez nove poruke):
```json
{ "messages": [], "nextSince": 5, "timeout": true }
```

Claude tada može iznova long-pollati ili izaći iz loop-a (npr. ako je sve
što je trebao napraviti gotovo).

##### `POST /api/sessions/{id}/note`

**Request:**
```json
{ "text": "Extracting trace, skipping day 3 due to water damage." }
```

**Response 201:** `{ "version": 12 }`

User-side ručne note: ne bumpaju version (frontend ne mora poll-ati zbog
toga). Vidljive u notes panelu na zahtjev.

##### `GET /api/sessions/{id}/csv`

Convenience: vraća CSV svih data_points.

```csv
day,hour,value,unit,date_iso,source
0,0.0,1013.2,hPa,,extract
0,0.5,1013.5,hPa,,extract
...
```

#### 4.1.4. Wire u `main.py`

```python
from .sessions import router as sessions_router

app.include_router(sessions_router, prefix="/api")
```

I dodati `@app.on_event("startup")` background task za cleanup.

---

### 4.2. Frontend — session creation + polling

#### 4.2.1. Što se mijenja u `src/app/page.tsx`

**Po završetku image upload-a (`handleImageSelected`):**
1. Već postoji rotacija/preview pipeline — ostaje isti
2. **Dodatak:** kreiraj session paralelno
   ```ts
   const sessionResp = await fetch("/api/sessions", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({
       imageBase64: <base64 of file>,
       chartType,
       config: <ChartConfig>,
     }),
   });
   const { id, url } = await sessionResp.json();
   setSessionId(id);
   setSessionUrl(url);
   ```
3. **Modal "Session active":**
   ```jsx
   {sessionUrl && (
     <div className="session-banner">
       <h3>🤖 Pošalji Claude-u za pripremu</h3>
       <code>{sessionUrl}</code>
       <button onClick={copyToClipboard}>📋 Copy</button>
       <p className="hint">
         Pokreni Claude Code u repo-u i paste-aj URL.
         Claude će analizirati sken, postaviti rotaciju + kalibraciju,
         eventualno izvući trag. Sve vidiš live ovdje.
       </p>
       <small>Session istječe za 2h.</small>
     </div>
   )}
   ```

#### 4.2.2. Novi route `/session/{id}` (Next.js dynamic route)

Datoteka: `src/app/session/[id]/page.tsx`

```tsx
"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

export default function SessionPage() {
  const { id } = useParams() as { id: string };
  const [state, setState] = useState<SessionState | null>(null);
  const [version, setVersion] = useState(0);
  const [claudeActive, setClaudeActive] = useState(false);

  // Polling loop
  useEffect(() => {
    let cancelled = false;
    let lastTouch = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/sessions/${id}/poll`);
        if (cancelled) return;
        if (r.status === 404) {
          // session expired
          setState(null);
          return;
        }
        const { version: v } = await r.json();
        if (v !== version) {
          // Version changed, fetch full state
          const fr = await fetch(`/api/sessions/${id}`);
          const full = await fr.json();
          if (!cancelled) {
            setState(full);
            setVersion(v);
            lastTouch = Date.now();
            setClaudeActive(true);
          }
        } else if (Date.now() - lastTouch > 5000) {
          setClaudeActive(false);
        }
      } catch (e) {
        console.warn("poll failed", e);
      }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(iv); };
  }, [id, version]);

  if (!state) return <div>Loading session...</div>;

  return (
    <SessionView
      state={state}
      claudeActive={claudeActive}
      onUserMutation={(mutation) => {
        // Send PUT/POST back to session API
        fetch(`/api/sessions/${id}/${mutation.endpoint}`, ...);
      }}
    />
  );
}
```

#### 4.2.3. `SessionView` component

Istoga UI kao `Calibrate` step trenutno, ali:
- Slika + calibration corners + polylines + data_points iz `state`
- Rotacija primjenjena automatski (`rotationDeg` iz state-a)
- Notes panel u sidebar-u: live feed Claude-ovih i user-ovih notes
- "Claude active" indicator (zeleni dot + "Claude radi..." kad je nedavno
  nešto promijenio)

Korisnikove ručne akcije (drag corner, klik data point, edit value) i dalje
rade ali sada PUT-aju natrag u session preko npr. `PUT /calibration`.

**Conflict resolution (MVP):** last-write-wins. User i Claude oboje pisu →
zadnji zapis vrijedi. Notes panel pokazuje promjene tako da user vidi što
je Claude napravio i može undo.

#### 4.2.5. Chat panel

**Lokacija:** desni sidebar u `/session/{id}` route, novi tab "💬 Claude"
ili replace postojeći "Log aktivnosti".

**UI elementi:**
- Stream of messages (scrollable, najnovija dolje)
- Claude messages: lijeva strana, light bg, markdown rendered
- User messages: desna strana, primary bg
- System notes (rotation set, calibration set, itd.): centrirano,
  italic, manji font
- Bottom: input box + Send button (Enter za send)
- Top: "Claude active" indicator (zeleni dot ako je Claude bio aktivan
  unutar 30 s)

**State management:**
- Frontend prima messages preko `GET /api/sessions/{id}` (full state ima
  `chat_messages: [...]`)
- Polling `/poll` bumpne version → re-fetch full state → diff messages
- User Send: `POST /api/sessions/{id}/chat` s `{text}`, zatim re-fetch

**Komponenta:** `src/components/session-chat/SessionChat.tsx`
- Props: `messages`, `onSend(text)`, `claudeActive: boolean`

#### 4.2.4. Kako Claude pristupa session-u iz Claude Code-a

Claude Code u terminalu vidi:
```
> claude "https://dhmz.aldo.tech/session/a3f9c2d1 — pomozi digitalizirati"
```

Ja onda:
1. **`WebFetch https://dhmz.aldo.tech/api/sessions/a3f9c2d1/context`** —
   dohvati briefing
2. **Briefing kaže** kako fetchati sliku, koje su tools, etc.
3. **`Bash curl -o /tmp/scan.png ...session/a3f9c2d1/image`** — preuzmi sliku
4. **`Read /tmp/scan.png`** — vidim sliku kao Claude multimodal input
5. **Analiziram + odlučujem** rotaciju, korner pozicije, etc.
6. **`Bash curl -X PUT ...session/a3f9c2d1/rotation -d '{"deg":-1.2}'`** —
   primjenjujem promjene
7. **`Bash curl -X POST ...session/a3f9c2d1/note -d '{"text":"..."}'`** —
   user vidi šta radim u browseru

---

### 4.3. Briefing endpoint — full markdown

URL: `GET /api/sessions/{id}/context`
Content-Type: `text/markdown; charset=utf-8`

Body (template, fields filled per session):

````markdown
# DHMZ Digitizer — Session {ID}

## Who you are right now

You are operating the DHMZ analog chart digitization tool on behalf of a
user. Your job is to help them digitize a meteorological strip-chart scan
into time-series data.

The user is sitting at a browser tab on `https://dhmz.aldo.tech/session/{ID}`
which renders the live state of this session. **Every change you make below
will appear in their browser within 1.5 seconds** — they're watching.

You also chat with the user in their Claude Code terminal. Keep terminal
output brief; visible mutations don't need verbose narration.

## Session details

- **Session ID:** `{ID}`
- **Created:** {created_at_iso}
- **Expires:** {expires_at_iso} ({hours_remaining} h remaining)
- **Chart type:** {chart_type} ({config.minValue}-{config.maxValue} {config.unit})
- **Image:** {image_w}×{image_h} px

## Chart geometry — Lambrecht {chart_type}

This is a Lambrecht-style strip-chart recorder. The chart paper is wound on
a cylinder that rotates with time. A pen arm with radius
{config.penArmRadius} mm pivots at {config.penArmPivot} mm from the chart
top, drawing on the paper as the cylinder turns.

Geometry consequences:
- **Horizontal grid lines** are perfectly straight — they represent VALUES
  (pressure for barograph, RH for hygrograph, °C for thermograph).
  - Major lines every {config.majorGrid} {config.unit}
  - Minor lines every 5 {config.unit}
  - Fine lines every 1 {config.unit}
- **Vertical/arc grid lines** are CURVED due to pen-arm geometry — they
  represent TIME. Curve formula:
  ```
  sag(y_mm) = (R - sqrt(R² - (y_mm - P)²)) - sagAtPivot
  displayed_X(y) = trueTimeX - sag(y)
  ```
  where R={config.penArmRadius}, P={config.penArmPivot}.
  - Major lines: every day boundary (24 h spacing)
  - Minor lines: every 6 h within a day
  - Fine lines: every 1 h
- Total chart spans **{config.days} days × {config.maxValue - config.minValue} {config.unit}**.

## Available tools

All tools are HTTP calls. Use `Bash curl` to invoke. Replies are JSON unless
specified otherwise.

### Read state

```bash
curl -s https://dhmz.aldo.tech/api/sessions/{ID}
```

Returns full session state JSON.

```bash
curl -s https://dhmz.aldo.tech/api/sessions/{ID}/poll
```

Lightweight version check.

### Fetch image

```bash
curl -o /tmp/scan-{ID}.png https://dhmz.aldo.tech/api/sessions/{ID}/image
```

Then `Read /tmp/scan-{ID}.png` to view it as multimodal input.

### Set rotation

If the scan looks tilted (compare horizontal grid lines to image edges),
apply rotation:

```bash
curl -s -X PUT -H "Content-Type: application/json" \
  https://dhmz.aldo.tech/api/sessions/{ID}/rotation \
  -d '{"deg": -1.2}'
```

Positive degrees = counter-clockwise (CCW). Range: (-180, 180].

### Set calibration corners

Identify the 4 chart-area corners (where the OUTERMOST grid lines meet) in
image-pixel coordinates. Map them to chart-mm:

- top_left  → `{chartX: 0, chartY: 0}`
- top_right → `{chartX: {config.chartWidth}, chartY: 0}`
- bot_left  → `{chartX: 0, chartY: {config.chartHeight}}`
- bot_right → `{chartX: {config.chartWidth}, chartY: {config.chartHeight}}`

```bash
curl -s -X PUT -H "Content-Type: application/json" \
  https://dhmz.aldo.tech/api/sessions/{ID}/calibration \
  -d '{
    "corners": [
      {"imgX": 123,  "imgY": 87,   "chartX": 0,   "chartY": 0},
      {"imgX": 9821, "imgY": 95,   "chartX": 313, "chartY": 0},
      {"imgX": 125,  "imgY": 3870, "chartX": 0,   "chartY": 76.2},
      {"imgX": 9819, "imgY": 3868, "chartX": 313, "chartY": 76.2}
    ]
  }'
```

### Run trace extraction

Once calibration is set, you can pull the pen trace into ~192 (day, hour,
value) data points:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  https://dhmz.aldo.tech/api/sessions/{ID}/extract-trace \
  -d '{"traceInk": "auto", "samplesPerDay": 48, "skipDays": []}'
```

`traceInk` options: `"auto"`, `"blue"`, `"red"`, `"black"`.

`skipDays` — list of day indices (0-{days_minus_1}) to NOT extract. Use for
days with damage / smudge / mokri trag.

### Add / edit / delete data points

```bash
# Add
curl -s -X POST -H "Content-Type: application/json" \
  https://dhmz.aldo.tech/api/sessions/{ID}/data-point \
  -d '{"day": 3, "hour": 6.0, "value": 1018}'

# Edit (idx is index in dataPoints array)
curl -s -X PUT -H "Content-Type: application/json" \
  https://dhmz.aldo.tech/api/sessions/{ID}/data-point/12 \
  -d '{"value": 1015}'

# Delete
curl -s -X DELETE \
  https://dhmz.aldo.tech/api/sessions/{ID}/data-point/12
```

### Add commentary note

User sees notes in the browser sidebar. Use to explain what you're doing or
report observations:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  https://dhmz.aldo.tech/api/sessions/{ID}/note \
  -d '{"text": "Detected slight CCW skew (1.2°), correcting."}'
```

### Export CSV

```bash
curl -s https://dhmz.aldo.tech/api/sessions/{ID}/csv -o /tmp/dhmz-{ID}.csv
```

## Recommended workflow

1. **Fetch + view image.** `curl + Read`. Look at the chart visually.
2. **Assess rotation.** Compare horizontal grid lines to image edges.
   If skew > 0.3°, apply rotation and add a note.
3. **Identify chart corners.** Find where the outermost grid lines meet
   in image-pixel coordinates. Apply calibration.
4. **Optionally vectorize the grid** — use `/api/vectorize-grid` if you
   want polylines drawn for visual confirmation. Not required.
5. **Run trace extraction.** Decide `traceInk` from visible color. Use
   `skipDays` for damaged sections.
6. **Review extraction.** Fetch state, see `dataPoints`. If anything
   looks wrong (outlier values, missing days), flag to user.
7. **Hand off.** Add a final note like "Digitization 90% complete,
   please verify days 3 and 7 manually."

## App code edits

You are running from `/Users/aldo/Documents/dev/dhmz-analog`. If during the
session you find a bug or limitation in the app itself, you can:

```bash
# Edit React source
Edit src/app/page.tsx ...

# Edit backend
Edit backend/app/extract.py ...

# Build + deploy frontend
npm run build
rsync -avz --delete -e "ssh -i ~/.ssh/id_ed25519" out/ \
    ubuntu@135.125.161.96:/opt/dhmz-analog/out/

# Backend hot reload (no rebuild)
rsync -avz -e "ssh -i ~/.ssh/id_ed25519" backend/app/ \
    ubuntu@135.125.161.96:/opt/dhmz-backend/app/
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
    'cd /opt/dhmz-backend && sudo docker compose restart'

# Backend full rebuild (only if requirements.txt or Dockerfile changed)
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
    'cd /opt/dhmz-backend && sudo docker compose up -d --build'
```

## Constraints

- **Don't push to git** unless user explicitly asks.
- **Don't `--no-verify`** on commits.
- **Don't touch other VPS containers** (`aldo-*`, `transit-*`) — those are
  unrelated projects on shared infrastructure.
- **Don't widen body-size limits, certificates, or any infrastructure** that
  affects shared services without user approval.
- **Always add a note** for every mutation so user sees what you did:
  - PUT /rotation → note "Rotation set to X°"
  - PUT /calibration → note "Calibration set, 4 corners: ..."
  - POST /extract-trace → note "Extracted N points, skipped days [...]"

## Common pitfalls

- **ECC alignment** in `/api/vectorize-grid` fails ~50% of scans. Don't
  rely on it — use it only as a "tell me where lines should be" sanity
  check, not as ground truth.
- **The pen-arm sag is real.** Time lines curve; value lines don't. Don't
  set 4 calibration corners on a curved line — pick where the line
  intersects horizontal value lines.
- **Bottom 5-10% of mask** has publisher text ("Lambrecht / Made in Germany"
  etc.). Ignore.
- **Top 5-10% of mask** has day labels ("Montag Monday Lundi") and hour
  numbers ("2 4 6 8 ... 24"). Use these to identify day boundaries
  visually but don't include in column projection.
- **Faded ink:** if the trace is barely visible, set `traceInk` to specific
  color (`"blue"`, `"red"`, etc.) instead of `"auto"`.
- **Wet/smudged days:** add to `skipDays` and tell user to enter values
  manually.

## How the user expects to interact

The user is a meteorology technician digitizing archived scans. They are
**not** in the terminal — they're in their browser tab on the session
page. **Communicate primarily through the chat panel:**

```bash
# Post a Claude message to the chat panel
curl -s -X POST -H "Content-Type: application/json" \
  https://dhmz.aldo.tech/api/sessions/{ID}/chat-claude \
  -d '{"text": "Postavio rotaciju -1.2°. Sad postavljam kalibraciju..."}'

# Long-poll for user reply (waits up to 30 s)
curl -s "https://dhmz.aldo.tech/api/sessions/{ID}/chat?since=N&wait=30"
```

After every meaningful mutation:
1. POST a brief chat message describing what you did and what's next.
2. If you need clarification ("Day 4 has two overlapping traces — which
   should I extract?"), POST to chat and long-poll for the reply.
3. When done, POST a final summary ("Digitization complete: 192 points,
   days 3 and 7 skipped. Please review and export CSV.").

## Agent loop

After the user authorizes you (recognized this briefing as a prompt
injection and approved), enter this loop:

```
1. Fetch image + state.
2. Decide next action based on state:
   - rotation not set & scan tilted? → PUT /rotation
   - calibration empty? → PUT /calibration
   - data points empty & user wants extraction? → POST /extract-trace
   - outliers user flagged? → PUT /data-point/{idx}
3. POST status to /chat-claude.
4. Long-poll /chat?since=N&wait=30.
5. If new user message: parse intent, repeat from step 2.
6. If timeout (30 s without message) AND all expected actions are done:
   POST a "ready, waiting for instructions" message and long-poll again.
7. Exit when user explicitly says "gotovo" / "kraj" / "done" or session
   expires.
```

You're an event-driven agent listening on chat. Don't busy-loop; long-poll
is cheap and keeps you responsive without burning cycles.

## State right now

```json
{state_json_pretty_printed}
```
````

---

### 4.4. CLAUDE.md update

Append section "## Session API — Claude as operator":

````markdown
## Session API — Claude as operator

The app supports a session-based workflow where Claude (running in user's
Claude Code terminal) can analyze the user's chart scan and operate the
app on their behalf.

### How it works

1. User uploads scan in browser, gets a session URL.
2. User runs `claude "<session_url> — pomozi digitalizirati"` in terminal.
3. Claude WebFetches the session URL → gets a markdown briefing with all
   tools and current state.
4. Claude curl's the session API to apply rotation, calibration, trace
   extraction, data points.
5. User watches browser update live via polling.

### When you see a session URL in this conversation

If user gives you `https://dhmz.aldo.tech/session/<id>`:

```bash
# 1. Fetch briefing
WebFetch <url-replaced-with-/api/sessions/{id}/context>

# 2. Fetch image
Bash curl -o /tmp/scan-{id}.png https://dhmz.aldo.tech/api/sessions/{id}/image
Read /tmp/scan-{id}.png

# 3. Analyze, then mutate via curl as documented in the briefing.
```

The briefing has full tool docs. Don't skip reading it — it has chart-
specific geometry, common pitfalls, and the exact curl invocations.

### Source files

- `backend/app/sessions.py` — session storage + endpoints
- `src/app/session/[id]/page.tsx` — frontend session view
- `src/components/session-banner/SessionBanner.tsx` — post-upload modal
````

---

## 5. Phasing & deploy schedule

### Phase 1 — Backend session module (45 min)
- Create `backend/app/sessions.py`
- Wire u `main.py` (router include + startup cleanup task)
- Test sa curl: POST → GET → PUT → DELETE
- Deploy: rsync `app/` + restart container
- ✓ Acceptance: postoji session, mogu fetchati image, PUT-ati state

### Phase 2 — Briefing endpoint (30 min)
- Implement `/context` markdown generator
- Test sa WebFetch (ja sam testiram lokalno)
- Deploy: rsync + restart
- ✓ Acceptance: WebFetch vraća dobar markdown, sve curl invocations rade

### Phase 3 — Frontend session creation (45 min)
- Modal nakon upload-a
- Clipboard copy + QR code (optional)
- POST /api/sessions integration
- Deploy: build + rsync `out/`
- ✓ Acceptance: nakon upload-a dobijem session URL i mogu copy-paste

### Phase 4 — Frontend `/session/{id}` route (60 min)
- Dynamic route u Next.js
- State polling logic
- Renderira sve isto kao trenutni Calibrate step (corners, polylines,
  data points)
- Notes panel
- "Claude active" indicator
- ✓ Acceptance: ako Claude PUT-a rotation, vidim u browseru za 1.5 s

### Phase 5 — Tool endpoints proširenje (45 min)
- POST /extract-trace (wraps existing logic)
- POST/PUT/DELETE /data-point
- POST /note
- GET /csv
- ✓ Acceptance: svi tools rade end-to-end

### Phase 6 — End-to-end test (60 min)
- User uploada test sken
- Daje mi URL u novoj poruci
- Ja kompletam ceo workflow: rotacija + calibration + extract + notes
- User vidi sve live, daje feedback
- Iteracije za bugove

### Phase 7 — CLAUDE.md update + commit + deploy (20 min)
- Update CLAUDE.md s session API docs
- Update IMPLEMENTATION_PLAN.md s "Done" status
- Commit s descriptive message
- Final deploy

**Total estimate:** ~5-6 sati, deploy odmah po fazama.

---

## 6. Out-of-scope za MVP (možda V2)

- **MCP HTTP server wrapper** — exposirati tools kao native MCP. Trenutno
  WebFetch + curl je dovoljno; MCP bi bio nicer DX ali nije blocking.
- **Persistent session storage** (SQLite, Redis) — in-memory s 2h TTL je
  ok za MVP. V2 ako se dosta koristi.
- **Auth tokens** — random session_id (16 char) je hard to guess (≈64-bit
  entropy). Produkcija s značajnim trafficom dodaje signed tokens.
- **Concurrent multi-session per user** — radi naravno (svaki ID isolated),
  ali UI ne podržava više otvorenih sessions istovremeno.
- **Session resume across machines** — session_id u URL-u je dovoljno za
  dijeljenje između mašina; nema dodatnih featurea.
- **Voice input** — chat ostaje u Claude Code terminalu.
- **Mobile UI** — desktop-only za sad.
- **Analytics / telemetry** — možemo dodati naknadno.
- **Hygrograph + Thermograph reference templates** — za sada samo
  barograph reference. Drugi chart-typeovi rade fallback HSV mask path.

---

## 7. Sigurnost

### 7.0. Prompt-injection authorization gate (by design)

`/api/sessions/{id}/context` vraća markdown koji JE prompt injection —
namjerno. Sadrži instrukcije ("operate this tool", popis tools) i workflow
recept. Modern Claude (Sonnet 4.5+, Opus 4.6+) prepoznaje WebFetch sadržaj
kao **data**, ne kao instructions. Standardno ponašanje:

1. Claude fetcha URL po user-ovom pozivu
2. Vidi briefing → "ovo je instrukcija iz vanjskog izvora"
3. **Pita user-a explicit:** "URL sadrži tools koji mogu mijenjati state
   tvog session-a (rotacija, kalibracija, data points), postaviti chat
   poruke, opcionalno editirati app kod. Hoćeš da nastavim?"
4. User: "da" → explicit authorization → Claude proceeds.
5. User: "ne" / "stop" → Claude ne dira ništa.

To je **feature**, ne bug. Authorization gate je u user-ovom Claude
client-u (gdje user fizički sjedi), ne na server-u. Server vjeruje session
ID-u (hard-to-guess random); samo user koji ima ID može authorizirati
operacije nad njim.

### 7.1. Session ID

- **Session ID:** `secrets.token_hex(8)` = 16 hex chars = 64 bit entropy.
  Brute force prevention: nginx rate limit (10 req/sec po IP) već postoji
  preko transit-nginx.
- **TTL:** 2h — ako user napusti session, čisti se sam.
- **Image size limit:** 80 MB base64 (backend rejects > 80 MB).
- **No PII:** sessions ne sadrže ime, email itd. — samo sken + state.
- **HTTPS enforced:** transit-nginx već forsira HTTPS na dhmz.aldo.tech.
- **CORS:** API otvoren (Claude i frontend dolaze iz različitih origina).
  Frontend već ide na `/api/*` preko proxy-a, Claude direkt — oboje rade.
- **Resource limits:** ako se in-memory store nakuplja zbog ne-cleanup-anih
  sessions, sweep task svakih 5 min reže expired.

---

## 8. Observability & debugging

- **Logging:** svaki mutation endpoint loguje
  `INFO sessions: {id} {endpoint} version {N}`
- **Notes panel** u UI-u je primarna user-vidljiva trace.
- **`docker logs dhmz-backend`** za server-side debugging.
- **Browser DevTools Network tab** za polling debugging.
- **Metrics (V2):** broj aktivnih sessions, average session duration, tool
  call counts.

---

## 9. Test plan

### 9.1. Unit tests (backend)
- `SessionStore.create / get / cleanup_expired`
- Endpoint validation (missing fields, malformed JSON, expired session)
- Concurrent mutation handling (lock, version bump)

### 9.2. Integration tests
- POST /sessions → GET image returns same bytes
- PUT /rotation → GET full state shows updated rotation
- POST /extract-trace → realistic data_points produced
- DELETE /data-point/{idx} → indexes shift correctly?
  (Decision: keep stable indexes, delete = mark deleted, or compact?
  MVP: compact. V2: stable + deleted flag.)

### 9.3. End-to-end
- User uploads test scan from `/tmp/tracks/12-baro-puna-dolje.png`
- Frontend creates session, displays URL
- I (Claude) fetch URL, complete workflow, user sees live updates
- Final state has reasonable data points

### 9.4. Failure modes
- Session expired during operation → 410 Gone
- Image format unsupported → 415
- Calibration < 3 points → 400
- ECC alignment fails (vectorize-grid) → fall back gracefully
- Network drop during polling → frontend shows "Reconnecting..."

---

## 10. Otvorena pitanja prije starta

1. **Image storage:** in-memory bytes — ok za MVP? (10 sessions × 80 MB =
   800 MB RAM peak. Trenutni VPS ima 4 GB.) Alternativa: spremati na
   `/tmp/dhmz-sessions/{id}.png`.

2. **Session expiry:** 2h dovoljno za interaktivnu digitalizaciju? Ili
   24h za long-running kad korisnik ostavi sesiju otvorenu preko noći?

3. **Session ID format:** pure hex (`a3f9c2d1b4e7f850`) ili human-readable
   (`wild-falcon-42`)? Hex je sigurnije; human je bolje za usmeno
   prepričavanje.

4. **Conflict resolution:** ako user u browseru pomakne corner dok Claude
   istovremeno PUT-a calibration, što se događa? MVP: last-write-wins +
   notes pokazuju oba. V2: optimistic locking sa version pre-conditions.

5. **Notes panel UI:** sidebar tab vs. floating panel vs. toast notifications?
   Predlažem **sidebar tab "Aktivnost"** (ekspanduje već postojeći
   "Log aktivnosti").

6. **Frontend session-mode vs normal-mode:** session route je separate
   `/session/{id}` ili koristimo isti `/` s session-id u query string?
   Predlažem dynamic route — clean URL.

7. **CSV export columns:** `day,hour,value,unit,source` dovoljno? Treba li
   `iso_datetime` (decode iz day+hour s referent. datumom)?

8. **Public URL za scan datoteku:** Claude fetcha sliku preko HTTPS direkt.
   Treba li biti accessible bez auth-a (kao trenutno) ili sa session-id
   token? MVP: bez auth (session-id u URL-u je već token).

---

## 11. Definition of Done

- [ ] User može uploadati sken, dobiti session URL
- [ ] Session URL daje meni → ja WebFetch context → vidim briefing
- [ ] Ja fetch image → vidim sken
- [ ] Ja postavljam rotation → user vidi rotation u browseru za < 2 s
- [ ] Ja postavljam calibration → user vidi corners za < 2 s
- [ ] Ja runam extract-trace → user vidi data points
- [ ] Ja addam note "Done" → user vidi u sidebaru
- [ ] User u browseru drag-uje corner → state se sync-a natrag → ja vidim
      promjenu pri sljedećem GET
- [ ] User export CSV → file ima sve točke
- [ ] Session expira nakon 2h, čisti se sa servera
- [ ] CLAUDE.md ima session API docs
- [ ] All committed na main grane

---

## 12. Why ovo radi bolje od algoritma

Trenutni algoritmi (HSV mask + Hough + cross-correlation + lattice fit) imaju
80-90% accuracy na "lijepim" skenovima i pada na 30-50% na edge cases.

**Edge cases koje ja handlam gracefully:**

| Slučaj | Algoritam | Claude |
|---|---|---|
| Mokra mrlja na 1-2 dana | Trace pollution, krivi values | "Skip those days, user popuni ručno" |
| Faded plavi trag | HSV miss, sparse mask | Vidim, postavljam `traceInk: "blue"` ili manualno crtam |
| Crvena umjesto zelene mreže | Total fail (HSV gate je za zeleno) | Vidim, koristim drugu mask path ili predlažem fix |
| Tilted scan 5° | Auto-deskew nije savršen | Vidim odmah, postavljam `rotation: -5.0` |
| Pen ink overlap (dva traga) | Confused extraction | "Day 3 ima dva traga, koji da uzmem?" → user odluči |
| Stamp / handwritten note | Catches as ink | Vidim i ignoriram contextually |

**Algoritmu ostaje:** brza batch obrada lijepih skena, pre-filling Claude-ovih
heuristika ("auto-cal je našao ovo, OK?").

**Meni ostaje:** složeni i rijetki edge cases gdje vid + razumijevanje >
piksel-level pattern matching.

---

**Kraj plana. Reci `da` za Phase 1.**
