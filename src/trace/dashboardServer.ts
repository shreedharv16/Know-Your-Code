import * as http from "http";
import { AddressInfo } from "net";
import { TraceTurn, TurnSnapshot } from "./traceTypes";

/**
 * The local "Project Story" dashboard — the big-picture, narrative-first view
 * of how the codebase evolved through AI turns.
 *
 * Tabs:
 *   Story        chronological chapters (sessions → turns) with real diffs,
 *                grounded explanations and structural facts
 *   Time Travel  pick a file, scrub through every turn that touched it, see
 *                the diff of each step and the file as it was at any point
 *   Files        churn map — which files/folders the AI reworks the most
 *   Ask          breakage detective: "it worked at turn X, broken now — why?"
 *
 * It binds to 127.0.0.1 on an ephemeral port. All data comes from the trace
 * service + shadow repo via the injected handlers; nothing leaves the machine
 * (the LLM endpoints behind explain/story/investigate are user-configured).
 */

export interface DashboardHandlers {
  getTurns(): TraceTurn[];
  getSnapshot(turnId: string): TurnSnapshot | undefined;
  /** Real unified diff one turn introduced (empty when unavailable). */
  diffOfTurn(turnId: string): Promise<string>;
  /** File content at a turn boundary. */
  fileAt(
    turnId: string,
    relPath: string,
    when: "before" | "after"
  ): Promise<string | undefined>;
  /** Grounded LLM explanation for a turn (cached upstream). */
  explain(turnId: string): Promise<string | undefined>;
  /** LLM biography of one file. */
  fileStory(relPath: string): Promise<string | undefined>;
  /**
   * Breakage detective from a last-known-good turn. The changed files + raw
   * diff are ground truth (no key needed); `analysis` is present only when
   * the LLM is configured.
   */
  investigate(
    fromTurnId: string,
    description: string
  ): Promise<{ changed: string[]; diff: string; analysis?: string } | undefined>;
  /** Time machine restore (shows a confirm dialog inside VS Code). */
  restore(turnId: string): Promise<boolean>;
  /**
   * AI-narration state: `on` is the user's explicit toggle (default off,
   * even when a key exists), `hasKey` whether api-keys.txt holds a key,
   * `llm` whether narration actually works (on && hasKey).
   */
  aiStatus(): { on: boolean; hasKey: boolean; llm: boolean };
  /**
   * Flip the toggle from the dashboard. Enabling without a key opens the
   * key+endpoint input flow inside VS Code; the returned state tells the
   * page whether that handoff is pending (on && !llm).
   */
  setAi(on: boolean): Promise<{ on: boolean; hasKey: boolean; llm: boolean }>;
}

export class DashboardServer {
  private server: http.Server | undefined;
  private url: string | undefined;

  constructor(private readonly handlers: DashboardHandlers) {}

  get running(): boolean {
    return !!this.server;
  }

  get address(): string | undefined {
    return this.url;
  }

  async start(): Promise<string> {
    if (this.server && this.url) {
      return this.url;
    }
    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          try {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          } catch {
            // response already sent
          }
        });
      });
      server.on("error", reject);
      // host 127.0.0.1 + port 0 -> OS picks a free local-only port
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        this.server = server;
        this.url = `http://127.0.0.1:${addr.port}`;
        resolve(this.url);
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      this.url = undefined;
    }
  }

  private json(res: http.ServerResponse, value: unknown, status = 200): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(value));
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
      if (Buffer.concat(chunks).length > 1024 * 1024) {
        return {};
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = u.pathname;
    const h = this.handlers;

    if (p === "/api/status") {
      this.json(res, h.aiStatus());
      return;
    }
    if (req.method === "POST" && p === "/api/ai") {
      const body = await this.readBody(req);
      this.json(res, await h.setAi(!!body.enabled));
      return;
    }
    if (p === "/api/trace") {
      const turns = h.getTurns().map((t) => ({
        ...t,
        snapshot: snapLite(h.getSnapshot(t.id))
      }));
      this.json(res, turns);
      return;
    }
    if (p === "/api/diff") {
      const turnId = u.searchParams.get("turn") ?? "";
      this.json(res, { diff: await h.diffOfTurn(turnId) });
      return;
    }
    if (p === "/api/file") {
      const turnId = u.searchParams.get("turn") ?? "";
      const relPath = u.searchParams.get("path") ?? "";
      const when = u.searchParams.get("when") === "before" ? "before" : "after";
      const content = await h.fileAt(turnId, relPath, when);
      this.json(res, { content: content ?? null });
      return;
    }
    if (req.method === "POST" && p === "/api/explain") {
      const body = await this.readBody(req);
      const text = await h.explain(String(body.turnId ?? ""));
      this.json(res, text ? { text } : { error: "Explanation unavailable — check the API key/endpoint, or this turn has no snapshot." });
      return;
    }
    if (req.method === "POST" && p === "/api/story") {
      const body = await this.readBody(req);
      const text = await h.fileStory(String(body.path ?? ""));
      this.json(res, text ? { text } : { error: "Story unavailable — needs an API key and at least one recorded snapshot touching this file." });
      return;
    }
    if (req.method === "POST" && p === "/api/investigate") {
      const body = await this.readBody(req);
      const result = await h.investigate(
        String(body.fromTurnId ?? ""),
        String(body.description ?? "")
      );
      this.json(
        res,
        result ?? { error: "Investigation unavailable — no snapshot exists for that turn (or git is unavailable)." }
      );
      return;
    }
    if (req.method === "POST" && p === "/api/restore") {
      const body = await this.readBody(req);
      const ok = await h.restore(String(body.turnId ?? ""));
      this.json(res, { ok });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(PAGE);
  }
}

function snapLite(s: TurnSnapshot | undefined) {
  if (!s) {
    return null;
  }
  return {
    changed: s.changed,
    historical: !!s.historical,
    hasDiff: !!(s.parent && s.changed && !s.historical)
  };
}

// ---------------------------------------------------------------------------
// The page. Self-contained, no external resources, dark/light aware.
// All dynamic content goes through esc(); interactivity uses data-action
// attributes + one delegated click handler (no inline JS in markup).
// ---------------------------------------------------------------------------

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Trace Your Code — Project Story</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    color-scheme: light dark;
    --bg:#0d1017; --panel:#141823; --card:#1a1f2c; --fg:#e8eaf0; --muted:#8b93a3;
    --line:#252b3a; --accent:#7c9cff; --accent2:#b07cff; --good:#5fbf77; --bad:#e06a5a;
    --warn:#d9a23f; --mono:ui-monospace,'Cascadia Code',Menlo,Consolas,monospace;
    --radius:12px; --shadow:0 1px 3px rgba(0,0,0,.3);
  }
  /* Manual theme override (header toggle): auto follows the OS; dark/light
     pin the palette. Every surface reads these variables, so one attribute
     swap re-themes the whole page. */
  :root[data-theme="dark"] { color-scheme:dark; }
  :root[data-theme="light"] {
    --bg:#f4f5f8; --panel:#fff; --card:#fbfbfd; --fg:#1c2130; --muted:#5e6675;
    --line:#e3e6ee; --shadow:0 1px 3px rgba(20,30,60,.08); color-scheme:light;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) { --bg:#f4f5f8; --panel:#fff; --card:#fbfbfd; --fg:#1c2130; --muted:#5e6675;
            --line:#e3e6ee; --shadow:0 1px 3px rgba(20,30,60,.08); }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system,'Segoe UI',Roboto,Inter,sans-serif; }
  header { padding:20px 28px 0; display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .logo { width:34px; height:34px; border-radius:9px; flex:0 0 auto;
          background:linear-gradient(135deg,var(--accent),var(--accent2));
          display:flex; align-items:center; justify-content:center; color:#fff; font-weight:800; }
  h1 { font-size:19px; margin:0; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:12.5px; }
  .spacer { flex:1; }
  .stats { display:flex; gap:18px; color:var(--muted); font-size:12px; }
  .stats b { color:var(--fg); font-size:15px; display:block; font-variant-numeric:tabular-nums; }
  nav { display:flex; gap:2px; padding:14px 28px 0; border-bottom:1px solid var(--line); overflow-x:auto; }
  @media (max-width:1100px){ .stats { display:none; } }
  @media (max-width:760px){ header { padding:14px 16px 0; } nav,.filters { padding-left:16px; padding-right:16px; } .wrap { padding:14px 16px 50px; } }
  .tab { padding:9px 16px; cursor:pointer; color:var(--muted); font-size:13.5px; font-weight:600;
         border-bottom:2px solid transparent; border-radius:8px 8px 0 0; user-select:none; }
  .tab:hover { color:var(--fg); background:var(--panel); }
  .tab.active { color:var(--fg); border-bottom-color:var(--accent); }
  .filters { display:flex; gap:8px; padding:14px 28px 0; align-items:center; flex-wrap:wrap; }
  input,select,textarea,button.btn {
    background:var(--panel); color:var(--fg); border:1px solid var(--line);
    border-radius:8px; padding:7px 10px; font-size:13px; font-family:inherit; }
  input:focus,select:focus,textarea:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  #q { min-width:140px; flex:1 1 220px; max-width:380px; }
  button.btn { cursor:pointer; font-weight:600; }
  button.btn:hover { border-color:var(--accent); }
  button.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.btn.danger:hover { border-color:var(--bad); color:var(--bad); }
  .wrap { padding:18px 28px 60px; }
  .pane { display:none; } .pane.active { display:block; }
  .muted { color:var(--muted); }
  .empty { padding:48px; text-align:center; color:var(--muted); }
  .chip { display:inline-block; font-size:11px; padding:2px 8px; border-radius:99px;
          background:var(--panel); border:1px solid var(--line); margin:2px 3px 2px 0; }
  .chip.click { cursor:pointer; } .chip.click:hover { border-color:var(--accent); color:var(--accent); }
  .chip.add { color:var(--good); border-color:color-mix(in srgb,var(--good) 40%,transparent); font-family:var(--mono); }
  .chip.del { color:var(--bad); border-color:color-mix(in srgb,var(--bad) 40%,transparent);
              font-family:var(--mono); text-decoration:line-through; }
  .chip.warnc { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 45%,transparent); }
  .src { font-size:10px; font-weight:800; padding:2px 7px; border-radius:5px; text-transform:uppercase; letter-spacing:.04em; }
  .src.claude-code { background:rgba(204,120,50,.18); color:#d9883f; }
  .src.copilot-chat { background:rgba(80,140,255,.16); color:#6ea8fe; }
  .src.antigravity { background:rgba(66,133,244,.16); color:#8ab4f8; }
  .mtag { font-size:10.5px; padding:1px 7px; border-radius:5px; background:var(--panel);
          border:1px solid var(--line); color:var(--muted); }

  /* ---- Story ---- */
  .session { margin-bottom:26px; }
  .sess-head { display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
  .sess-head h2 { font-size:15px; margin:0; font-weight:700; }
  .sess-line { flex:1; height:1px; background:var(--line); min-width:40px; }
  .turncard { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
              box-shadow:var(--shadow); padding:14px 18px; margin:0 0 12px 22px; position:relative; }
  .turncard::before { content:''; position:absolute; left:-22px; top:0; bottom:-12px; width:2px;
                      background:var(--line); }
  .turncard::after { content:''; position:absolute; left:-27px; top:20px; width:12px; height:12px;
                     border-radius:50%; background:var(--accent); border:3px solid var(--bg); }
  .turncard.dim::after { background:var(--muted); }
  .turncard.dim { opacity:.65; }
  .t-top { display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-bottom:6px; }
  .t-when { color:var(--muted); font-size:11.5px; font-variant-numeric:tabular-nums; }
  .t-prompt { font-size:14.5px; font-weight:650; line-height:1.4; margin:2px 0 6px; }
  .t-expl { background:color-mix(in srgb,var(--accent) 7%,transparent);
            border-left:3px solid var(--accent); border-radius:0 8px 8px 0;
            padding:8px 12px; margin:8px 0; font-size:13px; white-space:pre-wrap; }
  .t-expl .lbl { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.06em;
                 color:var(--accent); margin-bottom:3px; }
  .t-resp { color:var(--muted); font-size:12.5px; margin:4px 0; white-space:pre-wrap;
            max-height:5.5em; overflow:hidden; }
  .t-resp.expanded { max-height:none; }
  .t-resp:not(.expanded).clipped { -webkit-mask-image:linear-gradient(180deg,#000 60%,transparent);
                                   mask-image:linear-gradient(180deg,#000 60%,transparent); }
  .t-reason { font-size:12.5px; color:var(--muted); font-style:italic; white-space:pre-wrap;
              border-left:2px solid var(--line); padding-left:10px; margin:8px 0; }
  .t-risk { color:var(--warn); font-size:12.5px; margin:6px 0; }
  .linkish { color:var(--accent); cursor:pointer; font-size:12px; user-select:none; font-weight:600; }
  .t-files { margin:7px 0 3px; }
  .t-acts { display:flex; gap:7px; margin-top:9px; flex-wrap:wrap; }
  .diffbox { background:var(--panel); border:1px solid var(--line); border-radius:9px;
             margin-top:9px; overflow:auto; max-height:440px; font:12px/1.5 var(--mono); }
  .diffbox .dfile { position:sticky; top:0; background:var(--panel); padding:5px 12px;
                    font-weight:700; border-bottom:1px solid var(--line); }
  .diffbox .l { padding:0 12px; white-space:pre; }
  .diffbox .l.add { background:color-mix(in srgb,var(--good) 11%,transparent); color:var(--good); }
  .diffbox .l.del { background:color-mix(in srgb,var(--bad) 10%,transparent); color:var(--bad); }
  .diffbox .l.hunk { color:var(--accent); background:color-mix(in srgb,var(--accent) 7%,transparent); }
  .diffbox .l.meta { color:var(--muted); }
  .spin { display:inline-block; width:13px; height:13px; border:2px solid var(--line);
          border-top-color:var(--accent); border-radius:50%; animation:sp .7s linear infinite;
          vertical-align:-2px; margin-right:6px; }
  @keyframes sp { to { transform:rotate(360deg); } }

  /* ---- Time travel ---- */
  /* minmax(0,1fr): grid children default to min-width:auto, which lets wide
     content (the scrubber, diff boxes) push the column past the viewport. */
  .tt { display:grid; grid-template-columns:280px minmax(0,1fr); gap:16px; align-items:start; }
  .tt-main { min-width:0; }
  @media (max-width:900px){ .tt { grid-template-columns:1fr; } }
  .tt-list { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
             max-height:72vh; overflow:auto; }
  .tt-file { padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--line);
             display:flex; justify-content:space-between; gap:8px; font-size:13px; }
  .ttdir summary { display:flex; align-items:center; gap:6px; padding:7px 12px;
                   cursor:pointer; border-bottom:1px solid var(--line); font-size:12px;
                   font-weight:700; color:var(--muted); user-select:none; list-style:none; }
  .ttdir summary::-webkit-details-marker { display:none; }
  .ttdir summary:hover { background:var(--panel); }
  .ttdir .tw { transition:transform .12s; font-size:10px; flex:0 0 auto; }
  .ttdir[open] > summary .tw { transform:rotate(90deg); }
  .ttdir summary .dn { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ttdir summary .c { margin-left:auto; font-weight:400; font-size:11px; flex:0 0 auto; }
  .tt-file:hover { background:var(--panel); }
  .tt-file.sel { background:color-mix(in srgb,var(--accent) 12%,transparent); }
  .tt-file .n { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--mono); font-size:12px; }
  .tt-file .c { color:var(--muted); font-size:11px; flex:0 0 auto; }
  .tt-main { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px 20px; }
  .tt-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
  .tt-head .fname { font-family:var(--mono); font-weight:700; font-size:14px; }
  /* custom scrubber — no default browser blue, smooth thumb */
  .scrub { -webkit-appearance:none; appearance:none; display:block; width:100%;
           height:6px; border-radius:3px; margin:16px 0 8px; cursor:pointer;
           background:linear-gradient(90deg,var(--accent),var(--accent2)); opacity:.35; outline:none; }
  .scrub:hover, .scrub:active { opacity:.55; }
  .scrub:disabled { cursor:default; opacity:.15; }
  .scrub::-webkit-slider-thumb { -webkit-appearance:none; width:18px; height:18px;
    border-radius:50%; background:var(--accent); border:3px solid var(--card);
    box-shadow:0 1px 5px rgba(0,0,0,.35); transition:transform .08s ease; }
  .scrub::-webkit-slider-thumb:hover { transform:scale(1.18); }
  .scrub::-webkit-slider-thumb:active { transform:scale(1.28); }
  .scrub::-moz-range-thumb { width:16px; height:16px; border-radius:50%;
    background:var(--accent); border:3px solid var(--card); box-shadow:0 1px 5px rgba(0,0,0,.35); }
  .scrub::-moz-range-track { height:6px; border-radius:3px; background:transparent; }
  .scrub:focus-visible { box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 45%,transparent); }
  .scrub-meta { display:flex; justify-content:space-between; color:var(--muted); font-size:11.5px; }
  .stepinfo { margin:12px 0; }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .seg button { background:transparent; border:0; color:var(--muted); padding:5px 12px;
                cursor:pointer; font-size:12px; font-weight:600; }
  .seg button.on { background:var(--accent); color:#fff; }
  .filebox { background:var(--panel); border:1px solid var(--line); border-radius:9px; margin-top:10px;
             overflow:auto; max-height:50vh; font:12px/1.5 var(--mono); padding:10px 14px; white-space:pre; }
  .storybox { background:color-mix(in srgb,var(--accent2) 7%,transparent);
              border-left:3px solid var(--accent2); border-radius:0 8px 8px 0;
              padding:10px 14px; margin-top:12px; white-space:pre-wrap; font-size:13px; }

  /* ---- Files ---- */
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .bar { height:7px; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:4px; }
  .panelcard { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
               box-shadow:var(--shadow); padding:16px 20px; margin-bottom:16px; }
  .panelcard h2 { font-size:14px; margin:0 0 12px; }
  td .fn { font-family:var(--mono); font-size:12px; cursor:pointer; }
  td .fn:hover { color:var(--accent); }

  /* ---- Ask ---- */
  .ask { max-width:760px; }
  .ask label { display:block; font-size:12px; font-weight:700; color:var(--muted);
               text-transform:uppercase; letter-spacing:.04em; margin:14px 0 5px; }
  .ask select,.ask textarea { width:100%; }
  .ask textarea { min-height:84px; resize:vertical; }
  .verdict { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--warn);
             border-radius:var(--radius); padding:14px 18px; margin-top:16px; white-space:pre-wrap; font-size:13.5px; }
</style>
</head>
<body>
<header>
  <div class="logo">⟲</div>
  <div>
    <h1>Project Story</h1>
    <div class="sub">How this codebase evolved, turn by turn — grounded in real diffs, not chat claims</div>
  </div>
  <div class="spacer"></div>
  <div class="stats" id="stats"></div>
  <button class="btn" id="aibtn" data-action="ai-toggle"
        title="AI narration is optional and OFF by default. Everything you see is ground truth from the shadow snapshots — diffs, time travel, the breakage detective all work without it. Turning it on unlocks Explain, file stories and ranked suspects (needs an API key, set up in VS Code).">AI narration: off</button>
  <button class="btn" id="themebtn" data-action="theme" title="Theme: Auto follows your OS; Dark / Light pin it. Saved in this browser.">🌓 Auto</button>
  <button class="btn" data-action="export" title="Download the visible story as a Markdown report (changelog / standup notes)">Export report</button>
  <button class="btn" data-action="reload" title="Re-read the trace">Refresh</button>
</header>
<nav>
  <div class="tab active" data-tab="story">Story</div>
  <div class="tab" data-tab="travel">Time Travel</div>
  <div class="tab" data-tab="files">Files</div>
  <div class="tab" data-tab="ask">Ask</div>
</nav>
<div class="filters">
  <select id="scope">
    <option value="all">Everything</option>
    <option value="prompt">Prompts</option>
    <option value="file">Files</option>
    <option value="folder">Folders</option>
    <option value="response">Responses</option>
  </select>
  <input id="q" type="search" placeholder="Search the story…" />
  <select id="srcsel">
    <option value="all">All assistants</option>
    <option value="claude-code">Claude Code</option>
    <option value="copilot-chat">Copilot Chat</option>
    <option value="antigravity">Antigravity</option>
  </select>
  <span class="muted" id="fcount"></span>
</div>
<div class="wrap">
  <div class="pane active" id="pane-story"></div>
  <div class="pane" id="pane-travel"></div>
  <div class="pane" id="pane-files"></div>
  <div class="pane" id="pane-ask"></div>
</div>
<script>
'use strict';
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function fmtTime(iso){ try { return new Date(iso).toLocaleString(undefined,
  { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(e){ return ''; } }
function shortModel(m){ if(!m) return ''; m=String(m).trim();
  var s=m.lastIndexOf('/'); if(s>=0) m=m.slice(s+1); return m.replace(/-20\\d{6}$/,''); }
function folderOf(f){ var i=f.lastIndexOf('/'); return i<0?'(root)':f.slice(0,i); }
function inconseq(t){ if((t.filesTouched||[]).length) return false;
  return !(t.actions||[]).some(function(a){ return ['edit','create','delete','run'].includes(a.kind); }); }

// ---------- theme ----------
var THEME_LABELS = { auto: '🌓 Auto', dark: '🌙 Dark', light: '☀️ Light' };
function applyTheme(t){
  if (t === 'auto') { document.documentElement.removeAttribute('data-theme'); }
  else { document.documentElement.setAttribute('data-theme', t); }
  var b = document.getElementById('themebtn');
  if (b) { b.textContent = THEME_LABELS[t] || THEME_LABELS.auto; }
}
function cycleTheme(){
  var order = ['auto','dark','light'];
  var cur = localStorage.getItem('ct-theme') || 'auto';
  var next = order[(order.indexOf(cur)+1) % order.length];
  try { localStorage.setItem('ct-theme', next); } catch(e){}
  applyTheme(next);
}
applyTheme(localStorage.getItem('ct-theme') || 'auto');

var ALL = [];
var EXPANDED = {}; // turn id -> response card expanded (kept across refreshes)
var AI = { on: false, hasKey: false, llm: false };
var LLM = false;
var selFile = null, selStep = 0, fileView = 'diff';
var ttSteps = [], scrubTimer = null;

function renderAiBtn(){
  var b = document.getElementById('aibtn');
  if (!AI.on) { b.textContent = 'AI narration: off'; b.style.color = ''; }
  else if (AI.llm) { b.textContent = 'AI narration: on'; b.style.color = 'var(--good)'; }
  else { b.textContent = 'AI narration: key needed'; b.style.color = 'var(--warn)'; }
}

// ---------- data ----------
function load(){
  fetch('/api/status').then(function(r){ return r.json(); })
    .then(function(s){ AI = s || AI; LLM = !!AI.llm; })
    .catch(function(){ LLM = false; })
    .then(function(){
      renderAiBtn();
      return fetch('/api/trace');
    })
    .then(function(r){ return r.json(); })
    .then(function(d){ ALL = Array.isArray(d) ? d : []; renderAll(); })
    .catch(function(){ ALL = []; renderAll(); });
}

function matches(t){
  var srcv = document.getElementById('srcsel').value;
  if (srcv !== 'all' && t.source !== srcv) return false;
  var q = document.getElementById('q').value.trim().toLowerCase();
  if (!q) return true;
  var files = t.filesTouched || [];
  switch (document.getElementById('scope').value) {
    case 'prompt': return (t.prompt||'').toLowerCase().includes(q);
    case 'response': return ((t.response||'')+' '+(t.explanation||'')+' '+(t.summary||'')).toLowerCase().includes(q);
    case 'file': return files.some(function(f){ return f.toLowerCase().includes(q); });
    case 'folder': return files.some(function(f){ return folderOf(f).toLowerCase().includes(q); });
    default:
      return (t.prompt||'').toLowerCase().includes(q)
        || (t.response||'').toLowerCase().includes(q)
        || (t.explanation||'').toLowerCase().includes(q)
        || files.some(function(f){ return f.toLowerCase().includes(q); });
  }
}

// ---------- header stats ----------
function renderStats(turns){
  var files = {}; var sessions = {};
  turns.forEach(function(t){ sessions[t.sessionId]=1;
    (t.filesTouched||[]).forEach(function(f){ files[f]=(files[f]||0)+1; }); });
  document.getElementById('stats').innerHTML =
    '<div><b>'+turns.length+'</b>turns</div>'+
    '<div><b>'+Object.keys(sessions).length+'</b>sessions</div>'+
    '<div><b>'+Object.keys(files).length+'</b>files touched</div>';
  return files;
}

// ---------- diff rendering ----------
function renderDiff(diffText){
  if (!diffText || !diffText.trim()) {
    return '<div class="diffbox"><div class="l meta" style="padding:10px 12px">No diff captured for this turn (it may predate Trace Your Code, share a snapshot with a neighbouring turn, or git may be unavailable).</div></div>';
  }
  var out = ['<div class="diffbox">'];
  diffText.split('\\n').forEach(function(line){
    if (line.startsWith('diff --git')) {
      var m = line.match(/ b\\/(.*)$/);
      out.push('<div class="dfile">'+esc(m?m[1]:line)+'</div>');
    } else if (line.startsWith('+++')||line.startsWith('---')||line.startsWith('index ')||line.startsWith('new file')||line.startsWith('deleted file')) {
      out.push('<div class="l meta">'+esc(line)+'</div>');
    } else if (line.startsWith('@@')) {
      out.push('<div class="l hunk">'+esc(line)+'</div>');
    } else if (line.startsWith('+')) {
      out.push('<div class="l add">'+esc(line)+'</div>');
    } else if (line.startsWith('-')) {
      out.push('<div class="l del">'+esc(line)+'</div>');
    } else {
      out.push('<div class="l">'+esc(line||' ')+'</div>');
    }
  });
  out.push('</div>');
  return out.join('');
}

// ---------- Story tab ----------
function turnCard(t){
  var snap = t.snapshot || {};
  var html = ['<div class="turncard'+(inconseq(t)?' dim':'')+'" data-turn="'+esc(t.id)+'">'];
  html.push('<div class="t-top">',
    '<span class="src '+esc(t.source)+'">'+(t.source==='claude-code'?'Claude':t.source==='copilot-chat'?'Copilot':'Antigravity')+'</span>',
    t.model?'<span class="mtag">'+esc(shortModel(t.model))+'</span>':'',
    '<span class="t-when">'+esc(fmtTime(t.timestamp))+'</span>',
    snap.historical?'<span class="chip">pre-install</span>':'',
    '</div>');
  html.push('<div class="t-prompt">'+esc(t.prompt||'(no prompt)')+'</div>');
  if (t.explanation) {
    html.push('<div class="t-expl"><div class="lbl">What actually happened</div>'+esc(t.explanation)+'</div>');
  } else if (t.summary) {
    html.push('<div class="t-expl"><div class="lbl">Summary</div>'+esc(t.summary)+'</div>');
  }
  if (t.facts && ((t.facts.added||[]).length || (t.facts.removed||[]).length)) {
    html.push('<div>');
    (t.facts.added||[]).forEach(function(n){ html.push('<span class="chip add">+ '+esc(n)+'()</span>'); });
    (t.facts.removed||[]).forEach(function(n){ html.push('<span class="chip del">− '+esc(n)+'()</span>'); });
    html.push('</div>');
  }
  if (t.risk) { html.push('<div class="t-risk">⚠ '+esc(t.risk)+'</div>'); }
  if (t.reasoning) {
    html.push('<span class="linkish" data-action="toggle-reason">▸ what was it thinking?</span>',
      '<div class="t-reason" style="display:none">'+esc(t.reasoning)+'</div>');
  }
  if (t.response) {
    var long = t.response.length > 300 || t.response.split('\\n').length > 5;
    var exp = !!EXPANDED[t.id];
    html.push('<div class="t-resp'+(long&&!exp?' clipped':'')+(exp?' expanded':'')+'">'+esc(t.response)+'</div>');
    if (long) {
      html.push('<span class="linkish" data-action="toggle-more">'+(exp?'▴ show less':'▾ show more')+'</span>');
    }
  }
  if ((t.filesTouched||[]).length) {
    html.push('<div class="t-files">');
    t.filesTouched.forEach(function(f){
      html.push('<span class="chip click" data-action="filter-file" data-file="'+esc(f)+'">'+esc(f)+'</span>');
    });
    html.push('</div>');
  }
  html.push('<div class="t-acts">');
  if (snap.hasDiff) {
    html.push('<button class="btn" data-action="show-diff">View diff</button>');
  }
  if (LLM) {
    html.push('<button class="btn" data-action="explain">'+(t.explanation?'Re-explain':'Explain this change')+'</button>');
  }
  if ((t.filesTouched||[]).length && snap.hasDiff) {
    html.push('<button class="btn danger" data-action="undo">Undo turn…</button>');
  }
  html.push('</div><div class="diffslot"></div></div>');
  return html.join('');
}

function renderStory(turns){
  var pane = document.getElementById('pane-story');
  if (!turns.length) {
    pane.innerHTML = '<div class="empty">No activity recorded yet.<br>Use Claude Code, Copilot Chat, or Antigravity in this workspace — each turn becomes a chapter here automatically.</div>';
    return;
  }
  var bySession = {};
  turns.forEach(function(t){ (bySession[t.sessionId]=bySession[t.sessionId]||[]).push(t); });
  var sessions = Object.keys(bySession).map(function(id){
    var ts = bySession[id]; ts.sort(function(a,b){ return (a.timestamp||'').localeCompare(b.timestamp||''); });
    return { id:id, ts:ts, last:ts[ts.length-1].timestamp };
  }).sort(function(a,b){ return (b.last||'').localeCompare(a.last||''); });

  var html = [];
  sessions.forEach(function(s){
    var first = s.ts[0];
    var counts = {}; s.ts.forEach(function(t){ (t.filesTouched||[]).forEach(function(f){ counts[f]=(counts[f]||0)+1; }); });
    var rework = Object.keys(counts).filter(function(f){ return counts[f]>=3; });
    html.push('<div class="session">');
    html.push('<div class="sess-head"><h2>'+esc((first.prompt||'Session').slice(0,90))+'</h2>',
      '<span class="muted" style="font-size:12px">'+s.ts.length+' turn(s) · '+esc(fmtTime(s.last))+'</span>');
    if (rework.length) {
      html.push('<span class="chip warnc" title="These files were edited 3+ times this session">⟳ rework: '+esc(rework.slice(0,3).join(', '))+(rework.length>3?'…':'')+'</span>');
    }
    html.push('<div class="sess-line"></div></div>');
    s.ts.forEach(function(t){ html.push(turnCard(t)); });
    html.push('</div>');
  });
  pane.innerHTML = html.join('');
}

// ---------- Time Travel tab ----------
function turnsForFile(f){
  return ALL.filter(function(t){ return (t.filesTouched||[]).includes(f); })
    .sort(function(a,b){ return (a.timestamp||'').localeCompare(b.timestamp||''); });
}

function renderTravel(turns){
  var pane = document.getElementById('pane-travel');
  var counts = {};
  turns.forEach(function(t){ (t.filesTouched||[]).forEach(function(f){ counts[f]=(counts[f]||0)+1; }); });
  var files = Object.keys(counts).sort(function(a,b){ return counts[b]-counts[a]; });
  if (!files.length) {
    pane.innerHTML = '<div class="empty">No file edits recorded yet. Once an assistant changes files, pick one here and scrub through its history.</div>';
    return;
  }
  if (!selFile || !counts[selFile]) { selFile = files[0]; selStep = Math.max(0, turnsForFile(files[0]).length-1); }

  var list = ['<div class="tt-list">' + renderFileTree(counts) + '</div>'];

  ttSteps = turnsForFile(selFile);
  if (selStep >= ttSteps.length) selStep = ttSteps.length-1;
  if (selStep < 0) selStep = 0;

  var storyBtn = LLM
    ? '<button class="btn" data-action="tt-story">📖 Tell this file\\'s story</button>'
    : '<button class="btn" disabled title="Add an API key to generate the file\\'s biography">📖 Story (needs API key)</button>';

  var main = ['<div class="tt-main">'];
  main.push('<div class="tt-head"><span class="fname">'+esc(selFile)+'</span>',
    '<span class="muted" style="font-size:12px">'+ttSteps.length+' chapter(s)</span>',
    '<div class="spacer"></div>', storyBtn, '</div>');
  main.push('<input type="range" class="scrub" id="scrub" min="0" max="'+(ttSteps.length-1)+'" value="'+selStep+'" '+(ttSteps.length<2?'disabled':'')+' />');
  main.push('<div class="scrub-meta"><span>'+esc(fmtTime(ttSteps[0].timestamp))+'</span>',
    '<span id="scrub-pos">chapter '+(selStep+1)+' / '+ttSteps.length+'</span>',
    '<span>'+esc(fmtTime(ttSteps[ttSteps.length-1].timestamp))+'</span></div>');
  main.push('<div id="tt-step"></div>');
  main.push('<div class="seg" id="tt-seg">',
    '<button data-action="tt-view" data-view="diff" class="'+(fileView==='diff'?'on':'')+'">Diff of this step</button>',
    '<button data-action="tt-view" data-view="before" class="'+(fileView==='before'?'on':'')+'">File before</button>',
    '<button data-action="tt-view" data-view="after" class="'+(fileView==='after'?'on':'')+'">File after</button>',
    '</div>');
  main.push('<div id="tt-content"></div>');
  main.push('<div id="tt-story"></div></div>');

  pane.innerHTML = '<div class="tt">'+list.join('')+main.join('')+'</div>';

  // The scrubber updates IN PLACE — rebuilding the pane mid-drag would
  // destroy the slider under the pointer and kill the drag.
  var scrub = document.getElementById('scrub');
  if (scrub) scrub.addEventListener('input', function(){
    selStep = +this.value;
    var pos = document.getElementById('scrub-pos');
    if (pos) pos.textContent = 'chapter '+(selStep+1)+' / '+ttSteps.length;
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(updateTravelStep, 160);
  });
  updateTravelStep();
}

/**
 * Mirror the project's folder structure in the file list: collapsible
 * folders (with aggregated edit counts) instead of a flat path dump.
 */
function renderFileTree(counts){
  var root = { dirs:{}, files:[] };
  Object.keys(counts).forEach(function(p){
    var parts = p.split('/');
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      node = node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs:{}, files:[] };
    }
    node.files.push({ name: parts[parts.length-1], path: p, count: counts[p] });
  });
  function agg(node){
    var c = 0;
    Object.keys(node.dirs).forEach(function(k){ c += agg(node.dirs[k]); });
    node.files.forEach(function(f){ c += f.count; });
    node.count = c;
    return c;
  }
  agg(root);
  function render(node, depth){
    var html = [];
    Object.keys(node.dirs).sort().forEach(function(name){
      var d = node.dirs[name];
      html.push('<details open class="ttdir"><summary style="padding-left:'+(12+depth*14)+'px">',
        '<span class="tw">▸</span><span class="dn">'+esc(name)+'/</span><span class="c">'+d.count+'×</span></summary>',
        render(d, depth+1), '</details>');
    });
    node.files.sort(function(a,b){ return b.count - a.count || a.name.localeCompare(b.name); })
      .forEach(function(f){
        html.push('<div class="tt-file'+(f.path===selFile?' sel':'')+'" data-action="tt-select" data-file="'+esc(f.path)+'"',
          ' style="padding-left:'+(12+depth*14)+'px">',
          '<span class="n" title="'+esc(f.path)+'">'+esc(f.name)+'</span><span class="c">'+f.count+'×</span></div>');
      });
    return html.join('');
  }
  return render(root, 0);
}

function stepInfoHtml(cur){
  var snap = (cur && cur.snapshot) || {};
  return '<div class="stepinfo">'+
    '<div class="t-top"><span class="src '+esc(cur.source)+'">'+(cur.source==='claude-code'?'Claude':cur.source==='copilot-chat'?'Copilot':'Antigravity')+'</span>'+
    (cur.model?'<span class="mtag">'+esc(shortModel(cur.model))+'</span>':'')+
    '<span class="t-when">'+esc(fmtTime(cur.timestamp))+'</span>'+
    (snap.historical?'<span class="chip">pre-install</span>':'')+'</div>'+
    '<div class="t-prompt">'+esc(cur.prompt||'(no prompt)')+'</div>'+
    (cur.explanation?'<div class="t-expl"><div class="lbl">What actually happened</div>'+esc(cur.explanation)+'</div>':'')+
    '</div>';
}

function updateTravelStep(){
  var cur = ttSteps[selStep];
  var step = document.getElementById('tt-step');
  if (!cur || !step) return;
  step.innerHTML = stepInfoHtml(cur);
  var box = document.getElementById('tt-content');
  if (box) box.innerHTML = '<div class="muted" style="padding:14px"><span class="spin"></span>loading…</div>';
  loadTravelContent(cur);
}

var ttRequest = 0;
function loadTravelContent(cur){
  var box = document.getElementById('tt-content');
  if (!box || !cur) return;
  var token = ++ttRequest; // drop stale responses from rapid scrubbing
  if (fileView === 'diff') {
    fetch('/api/diff?turn='+encodeURIComponent(cur.id)).then(function(r){ return r.json(); })
      .then(function(d){
        if (token !== ttRequest) return;
        // scope the rendered diff to the selected file only
        var scoped = scopeDiff(d.diff||'', selFile);
        box.innerHTML = renderDiff(scoped);
      });
  } else {
    fetch('/api/file?turn='+encodeURIComponent(cur.id)+'&path='+encodeURIComponent(selFile)+'&when='+fileView)
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (token !== ttRequest) return;
        box.innerHTML = d.content === null
          ? '<div class="empty">The file did not exist at this point (or no snapshot is available).</div>'
          : '<div class="filebox">'+esc(d.content)+'</div>';
      });
  }
}

function scopeDiff(diff, file){
  if (!diff) return '';
  var blocks = diff.split(/^diff --git /m).filter(Boolean);
  var keep = blocks.filter(function(b){ return b.indexOf(' b/'+file+'\\n') >= 0 || b.startsWith('a/'+file+' '); });
  return keep.map(function(b){ return 'diff --git '+b; }).join('');
}

// ---------- Files tab ----------
function renderFiles(turns){
  var counts = {}; var lastPrompt = {};
  turns.forEach(function(t){ (t.filesTouched||[]).forEach(function(f){
    counts[f]=(counts[f]||0)+1; lastPrompt[f]=t.prompt||''; }); });
  var files = Object.keys(counts).map(function(f){ return [f,counts[f]]; })
    .sort(function(a,b){ return b[1]-a[1]; });
  var max = files.length ? files[0][1] : 1;
  var byFolder = {};
  files.forEach(function(e){ var d=folderOf(e[0]); byFolder[d]=(byFolder[d]||0)+e[1]; });
  var folders = Object.keys(byFolder).map(function(d){ return [d,byFolder[d]]; })
    .sort(function(a,b){ return b[1]-a[1]; });

  var html = ['<div class="panelcard"><h2>Most-revisited files — where the action (and the rework) is</h2><table><thead><tr><th>File</th><th class="num">Edits</th><th style="width:180px"></th><th>Last prompt that touched it</th></tr></thead><tbody>'];
  files.slice(0,60).forEach(function(e){
    html.push('<tr><td><span class="fn" data-action="tt-open" data-file="'+esc(e[0])+'" title="Open in Time Travel">'+esc(e[0])+'</span></td>',
      '<td class="num">'+e[1]+'</td>',
      '<td><div class="bar" style="width:'+Math.max(4,Math.round(e[1]/max*100))+'%"></div></td>',
      '<td class="muted" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((lastPrompt[e[0]]||'').slice(0,90))+'</td></tr>');
  });
  html.push('</tbody></table></div>');
  html.push('<div class="panelcard"><h2>By folder</h2><table><thead><tr><th>Folder</th><th class="num">Edits</th></tr></thead><tbody>');
  folders.slice(0,25).forEach(function(e){
    html.push('<tr><td>'+esc(e[0])+'</td><td class="num">'+e[1]+'</td></tr>');
  });
  html.push('</tbody></table></div>');
  document.getElementById('pane-files').innerHTML = files.length ? html.join('')
    : '<div class="empty">No file edits recorded yet.</div>';
}

// ---------- Ask tab ----------
function renderAsk(turns){
  // Preserve in-progress input/results across background re-renders.
  var prevDesc = document.getElementById('ask-desc');
  var prevFrom = document.getElementById('ask-from');
  var prevResult = document.getElementById('ask-result');
  var keepDesc = prevDesc ? prevDesc.value : '';
  var keepFrom = prevFrom ? prevFrom.value : '';
  var keepResult = prevResult ? prevResult.innerHTML : '';

  var withSnap = turns.filter(function(t){ return t.snapshot && !t.snapshot.historical; })
    .sort(function(a,b){ return (b.timestamp||'').localeCompare(a.timestamp||''); });
  var opts = withSnap.map(function(t){
    return '<option value="'+esc(t.id)+'">'+esc(fmtTime(t.timestamp))+' — '+esc((t.prompt||'(no prompt)').slice(0,80))+'</option>';
  }).join('');
  var blurb = LLM
    ? 'Pick the last point where things still worked. Trace Your Code diffs everything that happened since (the <i>real</i> changes on disk) and asks the LLM for ranked suspects.'
    : 'Pick the last point where things still worked. Trace Your Code shows every file that changed since, plus the full real diff — ground truth, no API key needed. <span class="muted">(Add a key to also get AI-ranked suspects.)</span>';
  document.getElementById('pane-ask').innerHTML =
    '<div class="ask"><div class="panelcard">'+
    '<h2>🔍 Something broke? Find out what changed.</h2>'+
    '<div class="muted" style="font-size:13px">'+blurb+'</div>'+
    '<label>It still worked at…</label><select id="ask-from">'+(opts||'<option value="">(no snapshotted turns yet)</option>')+'</select>'+
    '<label>What\\'s broken? (optional but helps)</label>'+
    '<textarea id="ask-desc" placeholder="e.g. Login button does nothing now; console shows a 401 right after page load"></textarea>'+
    '<div style="margin-top:12px"><button class="btn primary" data-action="investigate">'+(LLM?'Investigate':'Show what changed')+'</button></div>'+
    '</div><div id="ask-result"></div></div>';
  if (keepDesc) { document.getElementById('ask-desc').value = keepDesc; }
  if (keepFrom) {
    var sel = document.getElementById('ask-from');
    if (sel && Array.prototype.some.call(sel.options, function(o){ return o.value === keepFrom; })) {
      sel.value = keepFrom;
    }
  }
  if (keepResult) { document.getElementById('ask-result').innerHTML = keepResult; }
}

// ---------- actions (event delegation) ----------
document.addEventListener('click', function(ev){
  var el = ev.target.closest('[data-action]');
  if (!el) return;
  var action = el.getAttribute('data-action');
  var card = el.closest('[data-turn]');
  var turnId = card ? card.getAttribute('data-turn') : null;

  if (action === 'reload') { load(); }
  else if (action === 'export') { exportReport(); }
  else if (action === 'theme') { cycleTheme(); }
  else if (action === 'toggle-more') {
    var resp = el.previousElementSibling;
    if (resp && resp.classList.contains('t-resp')) {
      var expanded = resp.classList.toggle('expanded');
      resp.classList.toggle('clipped', !expanded);
      el.textContent = expanded ? '▴ show less' : '▾ show more';
      if (turnId) { EXPANDED[turnId] = expanded; } // survives re-renders
    }
  }
  else if (action === 'ai-toggle') {
    // off -> enable; on+working -> disable; on+key-missing -> ask.
    var enable;
    if (!AI.on) { enable = true; }
    else if (AI.llm) { enable = false; }
    else {
      enable = confirm('AI narration is on but no API key is set.\\n\\nOK = re-open the key setup in VS Code.\\nCancel = turn AI narration off.');
    }
    el.disabled = true;
    if (enable && !AI.hasKey) { el.textContent = 'finish key setup in VS Code…'; }
    fetch('/api/ai', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ enabled: enable }) })
      .then(function(r){ return r.json(); })
      .then(function(s){
        el.disabled = false;
        AI = s || AI; LLM = !!AI.llm;
        renderAiBtn();
        if (AI.on && !AI.llm) {
          alert('Almost there — switch to the VS Code window to enter your API key and endpoint, then come back and click Refresh.');
        }
        renderAll();
      })
      .catch(function(){ el.disabled = false; });
  }
  else if (action === 'toggle-reason') {
    var r = card.querySelector('.t-reason');
    var open = r.style.display === 'none';
    r.style.display = open ? 'block' : 'none';
    el.textContent = (open ? '▾ ' : '▸ ') + 'what was it thinking?';
  }
  else if (action === 'filter-file') {
    document.getElementById('scope').value = 'file';
    document.getElementById('q').value = el.getAttribute('data-file');
    renderAll(); window.scrollTo({top:0, behavior:'smooth'});
  }
  else if (action === 'show-diff') {
    var slot = card.querySelector('.diffslot');
    if (slot.innerHTML) { slot.innerHTML=''; el.textContent='View diff'; return; }
    el.innerHTML = '<span class="spin"></span>loading';
    fetch('/api/diff?turn='+encodeURIComponent(turnId)).then(function(r){ return r.json(); })
      .then(function(d){ slot.innerHTML = renderDiff(d.diff); el.textContent='Hide diff'; });
  }
  else if (action === 'explain') {
    el.innerHTML = '<span class="spin"></span>explaining…'; el.disabled = true;
    fetch('/api/explain', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ turnId: turnId }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        el.disabled = false; el.textContent = 'Re-explain';
        if (d.error) { alert(d.error); return; }
        load();
      });
  }
  else if (action === 'undo') {
    el.innerHTML = '<span class="spin"></span>confirm in VS Code…'; el.disabled = true;
    fetch('/api/restore', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ turnId: turnId }) })
      .then(function(r){ return r.json(); })
      .then(function(d){ el.disabled=false; el.textContent='Undo turn…';
        if (d.ok) { alert('Files restored to before this turn.'); } });
  }
  else if (action === 'tt-select') { selFile = el.getAttribute('data-file');
    selStep = Math.max(0, turnsForFile(selFile).length-1); renderTravel(ALL.filter(matches)); }
  else if (action === 'tt-open') {
    selFile = el.getAttribute('data-file');
    selStep = Math.max(0, turnsForFile(selFile).length-1);
    switchTab('travel'); renderTravel(ALL.filter(matches));
  }
  else if (action === 'tt-view') {
    fileView = el.getAttribute('data-view');
    document.querySelectorAll('#tt-seg button').forEach(function(b){
      b.classList.toggle('on', b.getAttribute('data-view') === fileView);
    });
    updateTravelStep();
  }
  else if (action === 'tt-story') {
    var sb = document.getElementById('tt-story');
    sb.innerHTML = '<div class="storybox"><span class="spin"></span>reading this file\\'s history…</div>';
    fetch('/api/story', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ path: selFile }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        sb.innerHTML = d.error ? '<div class="storybox">'+esc(d.error)+'</div>'
          : '<div class="storybox"><b>📖 The story of '+esc(selFile)+'</b>\\n\\n'+esc(d.text)+'</div>';
      });
  }
  else if (action === 'investigate') {
    var from = document.getElementById('ask-from').value;
    if (!from) { alert('No snapshotted turns to compare against yet.'); return; }
    var out = document.getElementById('ask-result');
    out.innerHTML = '<div class="verdict"><span class="spin"></span>diffing everything that changed since then'+(LLM?' and analyzing…':'…')+'</div>';
    fetch('/api/investigate', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ fromTurnId: from, description: document.getElementById('ask-desc').value }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.error) { out.innerHTML = '<div class="verdict">'+esc(d.error)+'</div>'; return; }
        var html = [];
        if (d.analysis) {
          html.push('<div class="verdict"><b>Likely suspects</b>\\n\\n'+esc(d.analysis)+'</div>');
        }
        var changed = d.changed || [];
        if (!changed.length) {
          html.push('<div class="verdict">Nothing has changed on disk since that point — the breakage is probably environmental (deps, config outside the workspace, services).</div>');
        } else {
          html.push('<div class="panelcard" style="margin-top:14px"><h2>'+changed.length+' file change(s) since then — ground truth</h2><div>');
          changed.forEach(function(c){ html.push('<span class="chip">'+esc(c)+'</span>'); });
          html.push('</div></div>');
          if (d.diff) {
            html.push('<div class="panelcard" style="margin-top:14px"><h2>The full real diff</h2>'+renderDiff(d.diff)+'</div>');
          }
          if (!d.analysis && !LLM) {
            html.push('<div class="verdict" style="margin-top:14px">Walk the diff above from the smallest change outward — or add an API key and re-run for ranked suspects with reasons.</div>');
          }
        }
        out.innerHTML = html.join('');
      });
  }
});

// ---------- export ----------
// Turns the visible story into a Markdown report — instant changelog /
// standup notes / PR description, grounded in what actually happened.
function exportReport(){
  var turns = ALL.filter(matches).slice()
    .sort(function(a,b){ return (a.timestamp||'').localeCompare(b.timestamp||''); });
  if (!turns.length) { alert('Nothing to export with the current filter.'); return; }
  var bySession = {};
  turns.forEach(function(t){ (bySession[t.sessionId]=bySession[t.sessionId]||[]).push(t); });
  var md = ['# Project Story', '', '_Generated ' + new Date().toLocaleString() +
    ' · ' + turns.length + ' turn(s) · grounded in real on-disk diffs_', ''];
  Object.keys(bySession).forEach(function(sid){
    var ts = bySession[sid];
    md.push('## ' + (ts[0].prompt || 'Session').slice(0, 90), '');
    ts.forEach(function(t){
      md.push('### ' + fmtTime(t.timestamp) + ' — ' + (t.prompt || '(no prompt)').slice(0, 140));
      if (t.model) md.push('*Model: ' + shortModel(t.model) + '*');
      if ((t.filesTouched||[]).length) md.push('**Files:** ' + t.filesTouched.join(', '));
      if (t.facts && ((t.facts.added||[]).length || (t.facts.removed||[]).length)) {
        var f = [];
        (t.facts.added||[]).forEach(function(n){ f.push('+' + n + '()'); });
        (t.facts.removed||[]).forEach(function(n){ f.push('-' + n + '()'); });
        md.push('**Declarations:** ' + f.join(', '));
      }
      if (t.explanation) { md.push('', t.explanation); }
      else if (t.summary) { md.push('', t.summary); }
      else if (t.response) { md.push('', '> ' + t.response.slice(0, 300).replace(/\\n/g, ' ')); }
      md.push('');
    });
  });
  var blob = new Blob([md.join('\\n')], { type: 'text/markdown' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'project-story.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

// tabs + filters
function switchTab(name){
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-tab')===name); });
  document.querySelectorAll('.pane').forEach(function(p){ p.classList.toggle('active', p.id==='pane-'+name); });
}
document.querySelectorAll('.tab').forEach(function(tab){
  tab.addEventListener('click', function(){ switchTab(tab.getAttribute('data-tab')); });
});
['scope','q','srcsel'].forEach(function(id){
  document.getElementById(id).addEventListener('input', renderAll);
});

function renderAll(){
  var turns = ALL.filter(matches);
  document.getElementById('fcount').textContent = turns.length + ' of ' + ALL.length + ' turn(s)';
  renderStats(turns);
  renderStory(turns);
  // Don't rebuild the Time Travel pane under the user's pointer mid-drag
  // (the background 20s refresh would otherwise destroy the slider).
  var active = document.activeElement;
  if (!(active && active.id === 'scrub')) { renderTravel(turns); }
  renderFiles(turns);
  renderAsk(turns);
}

load();
// Light background refresh — picks up new turns without hammering anything.
setInterval(load, 20000);
</script>
</body>
</html>`;
