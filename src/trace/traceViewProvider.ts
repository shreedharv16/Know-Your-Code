import * as vscode from "vscode";
import { TraceTurn, shortModel, isInconsequential } from "./traceTypes";

/**
 * The "Activity Timeline" view: a reverse-chronological list of prompt turns
 * from Claude Code and Copilot Chat. Each turn is expandable to show its tool
 * actions, files touched, token cost and (optional) LLM summary, plus a
 * "Revert this prompt" action that reuses the existing per-file revert engine.
 */
export class TraceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "changeTrackerTimeline";

  private view: vscode.WebviewView | undefined;
  private turns: TraceTurn[] = [];
  private ai = { on: false, hasKey: false, llm: false };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: {
      refresh: () => Promise<void>;
      summarizeAll: () => Promise<void>;
      revertPrompt: (relPaths: string[]) => Promise<void>;
      openFile: (relPath: string) => Promise<void>;
      openDashboard: () => Promise<void>;
      setApiKey: () => Promise<void>;
      /** Flip the AI-narration master toggle (default off). */
      toggleAi: (on: boolean) => Promise<void>;
      /** Open the before↔after diff for a turn from the shadow repo. */
      openTurnDiff: (turnId: string) => Promise<void>;
      /** Grounded LLM explanation of what the turn really did. */
      explainTurn: (turnId: string) => Promise<void>;
      /** Time machine: restore the turn's files to before the turn. */
      restoreTurn: (turnId: string) => Promise<boolean>;
    }
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "ready":
          this.render();
          break;
        case "refresh":
          await this.handlers.refresh();
          break;
        case "summarizeAll":
          await this.handlers.summarizeAll();
          break;
        case "revertPrompt":
          if (Array.isArray(msg.relPaths)) {
            await this.handlers.revertPrompt(msg.relPaths);
          }
          break;
        case "openFile":
          if (typeof msg.relPath === "string") {
            await this.handlers.openFile(msg.relPath);
          }
          break;
        case "openDashboard":
          await this.handlers.openDashboard();
          break;
        case "setApiKey":
          await this.handlers.setApiKey();
          break;
        case "toggleAi":
          await this.handlers.toggleAi(!!msg.on);
          break;
        case "openTurnDiff":
          if (typeof msg.turnId === "string") {
            await this.handlers.openTurnDiff(msg.turnId);
          }
          break;
        case "explainTurn":
          if (typeof msg.turnId === "string") {
            await this.handlers.explainTurn(msg.turnId);
          }
          break;
        case "restoreTurn":
          if (typeof msg.turnId === "string") {
            await this.handlers.restoreTurn(msg.turnId);
          }
          break;
      }
    });

    view.webview.html = this.html(view.webview);
  }

  setTurns(turns: TraceTurn[]): void {
    this.turns = turns;
    this.render();
  }

  /** Push the AI-narration state (toggle, key presence, effective). */
  setAi(state: { on: boolean; hasKey: boolean; llm: boolean }): void {
    this.ai = state;
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    // newest first; project to a lean shape for the webview
    const payload = [...this.turns]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((t) => ({
        id: t.id,
        source: t.source,
        sessionId: t.sessionId,
        model: shortModel(t.model),
        inconsequential: isInconsequential(t),
        timestamp: t.timestamp,
        prompt: t.prompt,
        reasoning: t.reasoning,
        response: t.response,
        summary: t.summary,
        explanation: t.explanation,
        facts: t.facts,
        risk: t.risk,
        filesTouched: t.filesTouched,
        actions: t.actions.map((a) => ({
          kind: a.kind,
          tool: a.tool,
          relPath: a.relPath,
          detail: a.detail
        })),
        tokens: t.tokens
      }));
    this.view.webview.postMessage({ type: "render", turns: payload, ai: this.ai });
    this.view.badge =
      this.turns.length > 0
        ? { value: this.turns.length, tooltip: `${this.turns.length} tracked turns` }
        : undefined;
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; }
  .hero { padding: 8px 10px 4px; display: flex; flex-direction: column; gap: 6px; }
  .dash-btn { width: 100%; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 400; }
  .dash-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .ai-status { display: flex; align-items: center; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; padding: 0 2px; }
  .switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .switch .track { width: 26px; height: 14px; border-radius: 8px; background: var(--vscode-descriptionForeground, #888); opacity: .45; transition: background .15s, opacity .15s; display: inline-block; position: relative; }
  .switch .knob { position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-editor-background, #fff); transition: transform .15s; }
  .switch input:checked + .track { background: var(--vscode-charts-green, #5fbf77); opacity: 1; }
  .switch input:checked + .track .knob { transform: translateX(12px); }
  .footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
  .open-dash { color: var(--vscode-textLink-foreground); cursor: pointer; user-select: none; font-weight: 600; }
  .open-dash:hover { text-decoration: underline; }
  .turn { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
  .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; }
  .head:hover { background: var(--vscode-list-hoverBackground); }
  .src { flex: 0 0 auto; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: .03em; }
  .src.claude-code { background: rgba(204,120,50,.22); color: #d9883f; }
  .src.copilot-chat { background: rgba(80,140,255,.20); color: #6ea8fe; }
  .src.antigravity { background: rgba(66,133,244,.20); color: #8ab4f8; }
  .prompt { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .model { flex: 0 0 auto; font-size: 10px; padding: 1px 5px; border-radius: 3px; background: rgba(128,128,128,.18); color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .when { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
  .turn.inconsequential .head .prompt { opacity: .55; font-style: italic; }
  .turn.inconsequential { opacity: .82; }
  .chev { flex: 0 0 auto; width: 12px; color: var(--vscode-descriptionForeground); transition: transform .12s; }
  .turn.open .chev { transform: rotate(90deg); }
  .body { display: none; padding: 2px 10px 10px 26px; }
  .turn.open .body { display: block; }
  .summary { margin: 2px 0 8px; color: var(--vscode-foreground); }
  .block { margin: 0 0 8px; border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.35)); padding: 2px 0 2px 8px; }
  .block .label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .block .text { white-space: pre-wrap; color: var(--vscode-foreground); font-size: 12px; line-height: 1.45; }
  .block.reasoning .text { color: var(--vscode-descriptionForeground); font-style: italic; }
  .toggle { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 11px; user-select: none; margin-bottom: 8px; display: inline-block; }
  .risk { margin: 0 0 8px; color: var(--vscode-editorWarning-foreground, #cca700); font-size: 12px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 6px; font-variant-numeric: tabular-nums; }
  .files { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
  .file { display: flex; gap: 6px; align-items: center; cursor: pointer; padding: 1px 4px; border-radius: 3px; }
  .file:hover { background: var(--vscode-list-hoverBackground); }
  .badge { font-size: 10px; font-weight: 700; width: 14px; text-align: center; }
  .edit { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .create { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .delete { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .actions { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
  .chip { font-size: 10px; padding: 1px 6px; border-radius: 9px; background: var(--vscode-badge-background, rgba(128,128,128,.2)); color: var(--vscode-badge-foreground, var(--vscode-foreground)); }
  .chip.factadd { background: rgba(80,180,100,.18); color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); font-family: var(--vscode-editor-font-family, monospace); }
  .chip.factdel { background: rgba(200,80,60,.16); color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); font-family: var(--vscode-editor-font-family, monospace); text-decoration: line-through; }
  .block.explanation { border-left-color: var(--vscode-textLink-foreground, #6ea8fe); }
  .btnrow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  button.act { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-border, rgba(128,128,128,.35)); padding: 3px 9px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button.act:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .empty { padding: 16px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
  .filterbar { display: flex; gap: 6px; padding: 6px 8px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
  .filterbar input, .filterbar select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
  .filterbar input { flex: 1 1 auto; min-width: 60px; }
  .count { padding: 4px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
</style>
</head>
<body>
<div class="hero">
  <button class="dash-btn" id="dashbtn" title="The full experience: scrub any file through time, view real diffs, export reports">Open Project Story \u2197</button>
  <div class="ai-status">
    <label class="switch" title="Optional: unlocks Explain, file stories and ranked breakage suspects. Everything else works without it. Off by default \u2014 needs your explicit opt-in even if a key exists.">
      <input type="checkbox" id="aitog" />
      <span class="track"><span class="knob"></span></span>
    </label>
    <span id="ailabel">AI narration off</span>
    <span class="open-dash" id="aikey" style="display:none">Add API key</span>
  </div>
</div>
<div class="filterbar">
  <input id="filter" type="text" placeholder="Filter prompts, files, responses\u2026" />
  <select id="src" title="Source" style="display:none">
    <option value="all">Both</option>
    <option value="claude-code">Claude</option>
    <option value="copilot-chat">Copilot</option>
    <option value="antigravity">Antigravity</option>
  </select>
</div>
<div id="root"></div>
<div class="footer">
  <span id="count"></span>
</div>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const root = document.getElementById('root');
  const countEl = document.getElementById('count');
  const aiTog = document.getElementById('aitog');
  const aiLabel = document.getElementById('ailabel');
  const aiKey = document.getElementById('aikey');
  let aiState = { on: false, hasKey: false, llm: false };
  document.getElementById('dashbtn').addEventListener('click', () => api.postMessage({ type: 'openDashboard' }));
  aiTog.addEventListener('change', () => api.postMessage({ type: 'toggleAi', on: aiTog.checked }));
  aiKey.addEventListener('click', () => api.postMessage({ type: 'setApiKey' }));

  function renderAiStatus(ai) {
    aiState = ai || aiState;
    aiTog.checked = !!aiState.on;
    if (!aiState.on) {
      aiLabel.textContent = 'AI narration off';
      aiKey.style.display = 'none';
    } else if (aiState.llm) {
      aiLabel.textContent = 'AI narration on';
      aiKey.style.display = 'none';
    } else {
      aiLabel.textContent = 'AI narration on — key needed';
      aiKey.style.display = '';
    }
  }

  let allTurns = [];
  let mixedSources = false;
  const filterEl = document.getElementById('filter');
  const srcEl = document.getElementById('src');
  filterEl.addEventListener('input', apply);
  srcEl.addEventListener('change', apply);

  function fmtTime(iso) {
    try { const d = new Date(iso); return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }
  function kindBadge(k) {
    if (k === 'create') return 'A';
    if (k === 'delete') return 'D';
    return 'M';
  }

  function renderTurn(turn) {
    const el = document.createElement('div');
    el.className = 'turn' + (turn.inconsequential ? ' inconsequential' : '');

    const head = document.createElement('div');
    head.className = 'head';
    const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '\u203A';
    const prompt = document.createElement('span'); prompt.className = 'prompt'; prompt.textContent = turn.prompt || '(no prompt text)';
    const when = document.createElement('span'); when.className = 'when'; when.textContent = fmtTime(turn.timestamp);
    head.append(chev);
    // Only badge the source when the timeline actually mixes assistants \u2014
    // a wall of identical "CLAUDE" chips is noise, not signal.
    if (mixedSources) {
      const src = document.createElement('span'); src.className = 'src ' + turn.source; src.textContent = turn.source === 'claude-code' ? 'Claude' : turn.source === 'copilot-chat' ? 'Copilot' : 'Antigravity';
      head.appendChild(src);
    }
    head.append(prompt, when);
    head.addEventListener('click', () => el.classList.toggle('open'));

    const body = document.createElement('div');
    body.className = 'body';

    if (turn.explanation) {
      const ex = document.createElement('div'); ex.className = 'block explanation';
      const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = 'What actually happened';
      const txt = document.createElement('div'); txt.className = 'text'; txt.textContent = turn.explanation;
      ex.append(lbl, txt);
      body.appendChild(ex);
    } else if (turn.summary) {
      const s = document.createElement('div'); s.className = 'summary'; s.textContent = turn.summary; body.appendChild(s);
    }
    if (turn.facts && ((turn.facts.added||[]).length || (turn.facts.removed||[]).length)) {
      const fx = document.createElement('div'); fx.className = 'actions';
      for (const n of (turn.facts.added||[])) {
        const c = document.createElement('span'); c.className = 'chip factadd'; c.textContent = '+ ' + n + '()'; fx.appendChild(c);
      }
      for (const n of (turn.facts.removed||[])) {
        const c = document.createElement('span'); c.className = 'chip factdel'; c.textContent = '− ' + n + '()'; fx.appendChild(c);
      }
      body.appendChild(fx);
    }
    if (turn.risk) {
      const r = document.createElement('div'); r.className = 'risk'; r.textContent = '\u26A0 ' + turn.risk; body.appendChild(r);
    }

    // Reasoning (hidden behind a toggle since it's long).
    if (turn.reasoning) {
      const toggle = document.createElement('span'); toggle.className = 'toggle'; toggle.textContent = '\u25B8 show reasoning';
      const block = document.createElement('div'); block.className = 'block reasoning'; block.style.display = 'none';
      const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = 'Reasoning';
      const txt = document.createElement('div'); txt.className = 'text'; txt.textContent = turn.reasoning;
      block.append(lbl, txt);
      toggle.addEventListener('click', () => {
        const open = block.style.display === 'none';
        block.style.display = open ? 'block' : 'none';
        toggle.textContent = (open ? '\u25BE hide' : '\u25B8 show') + ' reasoning';
      });
      body.append(toggle, block);
    }

    // Response (the model's own words about what it did).
    if (turn.response) {
      const block = document.createElement('div'); block.className = 'block response';
      const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = 'Response';
      const txt = document.createElement('div'); txt.className = 'text'; txt.textContent = turn.response;
      block.append(lbl, txt);
      body.appendChild(block);
    }

    const meta = document.createElement('div'); meta.className = 'meta';
    const metaParts = [];
    if (turn.model) { metaParts.push(turn.model); }
    metaParts.push(turn.filesTouched.length + ' file(s)');
    metaParts.push(turn.actions.length + ' action(s)');
    meta.textContent = metaParts.join(' \u00B7 ');
    body.appendChild(meta);

    if (turn.actions.length) {
      const acts = document.createElement('div'); acts.className = 'actions';
      const counts = {};
      for (const a of turn.actions) { counts[a.tool] = (counts[a.tool] || 0) + 1; }
      for (const tool of Object.keys(counts)) {
        const c = document.createElement('span'); c.className = 'chip';
        c.textContent = tool + (counts[tool] > 1 ? ' \u00D7' + counts[tool] : '');
        acts.appendChild(c);
      }
      body.appendChild(acts);
    }

    if (turn.filesTouched.length) {
      const files = document.createElement('div'); files.className = 'files';
      const kindByPath = {};
      for (const a of turn.actions) { if (a.relPath) kindByPath[a.relPath] = a.kind; }
      for (const f of turn.filesTouched) {
        const row = document.createElement('div'); row.className = 'file';
        const k = kindByPath[f] || 'edit';
        const b = document.createElement('span'); b.className = 'badge ' + k; b.textContent = kindBadge(k);
        const name = document.createElement('span'); name.textContent = f;
        row.append(b, name);
        row.addEventListener('click', () => api.postMessage({ type: 'openFile', relPath: f }));
        files.appendChild(row);
      }
      body.appendChild(files);
    }

    // Time-machine row: real diff, grounded explanation, one-click undo.
    const row = document.createElement('div'); row.className = 'btnrow';
    const mk = (label, title, type) => {
      const b = document.createElement('button'); b.className = 'act';
      b.textContent = label; b.title = title;
      b.addEventListener('click', () => api.postMessage({ type, turnId: turn.id }));
      return b;
    };
    row.appendChild(mk('View diff', 'Open the before ↔ after diff for this turn (from the shadow snapshot)', 'openTurnDiff'));
    row.appendChild(mk(turn.explanation ? 'Re-explain' : 'Explain', 'Explain what this turn really did, grounded in the actual diff', 'explainTurn'));
    if (turn.filesTouched.length) {
      row.appendChild(mk('Undo turn', 'Restore the files this turn touched to their state BEFORE the turn', 'restoreTurn'));
    }
    body.appendChild(row);

    el.append(head, body);
    return el;
  }

  function render(turns) {
    root.textContent = '';
    if (!turns || turns.length === 0) {
      countEl.textContent = '';
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = allTurns.length
        ? 'No turns match the current filter.'
        : 'No assistant activity yet. Use Claude Code, Copilot Chat, or Antigravity in this workspace \u2014 turns appear here automatically. For the full story (scrubbing, diffs, explanations), open the Project Story dashboard below.';
      root.appendChild(e);
      return;
    }
    countEl.textContent = turns.length + ' of ' + allTurns.length + ' turn(s)';
    for (const t of turns) { root.appendChild(renderTurn(t)); }
  }

  function matches(turn) {
    if (srcEl.value !== 'all' && turn.source !== srcEl.value) { return false; }
    const q = filterEl.value.trim().toLowerCase();
    if (!q) { return true; }
    const files = (turn.filesTouched || []);
    return (turn.prompt || '').toLowerCase().includes(q)
      || (turn.response || '').toLowerCase().includes(q)
      || (turn.summary || '').toLowerCase().includes(q)
      || (turn.explanation || '').toLowerCase().includes(q)
      || files.some(f => f.toLowerCase().includes(q));
  }

  function apply() {
    render(allTurns.filter(matches));
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'render') {
      allTurns = e.data.turns || [];
      mixedSources = new Set(allTurns.map(t => t.source)).size > 1;
      srcEl.style.display = mixedSources ? '' : 'none';
      renderAiStatus(e.data.ai);
      apply();
    }
  });
  api.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
