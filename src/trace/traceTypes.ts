/**
 * Shared data model for the "activity trace" layer.
 *
 * This layer sits ON TOP of the existing checkpoint/diff engine. The diff
 * engine answers "what changed on disk?"; the trace layer answers "why did it
 * change, in what order, at what token cost, and which prompt caused it?".
 *
 * Facts here come from STRUCTURED logs (Claude Code JSONL, Copilot Chat debug
 * logs) — never from scraping rendered chat text. The LLM is only used to add a
 * plain-English summary/risk note on top of these facts (see summarizer.ts).
 */

/** Which assistant produced a turn. */
export type TraceSource = "claude-code" | "copilot-chat" | "antigravity";

/** A single tool invocation the assistant made during a turn. */
export interface TraceAction {
  /** Normalized kind so the UI can group/icon consistently. */
  kind: "edit" | "create" | "delete" | "read" | "search" | "run" | "other";
  /** Raw tool name as reported by the source (e.g. "Edit", "Bash", "Grep"). */
  tool: string;
  /** Workspace-relative file path, when the action targets a file. */
  relPath?: string;
  /** Short human-readable detail (command run, query, etc.). */
  detail?: string;
}

/** Token accounting for a turn (best-effort; sources vary). */
export interface TokenUsage {
  input: number;
  output: number;
  /** Cache read/creation tokens when the source reports them. */
  cacheRead?: number;
  cacheWrite?: number;
}

/** One prompt -> assistant response unit. The atom of the timeline. */
export interface TraceTurn {
  /** Stable id (source + session + index) so we can de-dupe across re-parses. */
  id: string;
  source: TraceSource;
  /** Session/conversation id this turn belongs to. */
  sessionId: string;
  /** ISO timestamp of the turn (assistant response time when available). */
  timestamp: string;
  /** The user's prompt text that started the turn (trimmed/clipped). */
  prompt: string;
  /** Model/deployment that produced the turn (e.g. "claude-haiku-4-5"). */
  model?: string;
  /** The assistant's reasoning ("thinking"), when the source records it. */
  reasoning?: string;
  /** The assistant's reply text (what it said it did). */
  response?: string;
  /** Tool actions the assistant took, in order. */
  actions: TraceAction[];
  /** Distinct workspace-relative files the turn edited/created/deleted. */
  filesTouched: string[];
  /** Token usage for the turn. */
  tokens: TokenUsage;
  /** LLM-distilled one/two-line "what & why" (filled in lazily). */
  summary?: string;
  /**
   * Grounded narrative for the turn: what was built, which functions appeared,
   * how the diff satisfies the prompt. Derived from the REAL shadow-git diff
   * (never from the model's self-description alone). Filled on demand.
   */
  explanation?: string;
  /** Structural facts mined from the real diff (no LLM): declarations +/-. */
  facts?: { added: string[]; removed: string[] };
  /** LLM/heuristic risk flag, e.g. "touched .env / auth files". */
  risk?: string;
  /** Hash of the inputs the summary was derived from (cache key). */
  summaryKey?: string;
}

/**
 * The shadow-git snapshot recorded for a turn: project state AFTER the turn
 * (`commit`) and BEFORE it (`parent`). `changed:false` marks turns that share
 * a snapshot with a neighbour (batched) or predate the shadow repo (baseline).
 */
export interface TurnSnapshot {
  commit: string;
  parent?: string;
  changed: boolean;
  /** True for turns that happened before the shadow repo existed. */
  historical?: boolean;
}

/** Everything the store persists. */
export interface TraceData {
  version: number;
  /** Workspace folder fsPath this trace was built for. */
  root: string;
  turns: TraceTurn[];
  /** Turn id -> shadow-git snapshot. Additive; absent before v0.2. */
  snapshots?: Record<string, TurnSnapshot>;
}

export const TRACE_VERSION = 1;

/** Files whose mere presence in a turn warrants a risk flag. */
const RISKY_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /secret|credential|password|apikey|api[-_]?key|token/i,
  /(^|\/)auth/i,
  /\.pem$|\.key$/i
];

/** Heuristic risk note from the set of touched files (no LLM needed). */
export function computeRisk(filesTouched: string[]): string | undefined {
  const hits = filesTouched.filter((f) =>
    RISKY_PATTERNS.some((re) => re.test(f))
  );
  if (hits.length === 0) {
    return undefined;
  }
  const shown = hits.slice(0, 3).join(", ");
  return `Touched sensitive file(s): ${shown}${hits.length > 3 ? "…" : ""}`;
}

/**
 * Prompts in the logs are polluted with machine-generated wrappers: slash
 * commands, IDE events, local-command stdout/caveats. These are system events,
 * not human intent. We strip the wrappers to recover the real prompt, and flag
 * a turn as "noise" when nothing human remains.
 */
const WRAPPER_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi; // <ide_opened_file>, <command-name>, etc.

/** Strip XML-ish wrapper tags and their typical inner payloads from a prompt. */
export function cleanPrompt(raw: string): string {
  let s = raw;
  // Remove whole known wrapper blocks (tag + inner text) first.
  s = s.replace(
    /<(ide_opened_file|ide_selection|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/gi,
    " "
  );
  // Remove any remaining standalone tags.
  s = s.replace(WRAPPER_TAG, " ");
  // Collapse whitespace.
  return s.replace(/\s+/g, " ").trim();
}

/**
 * True when a raw prompt is purely a machine/system event (slash command, IDE
 * open notification, local command echo) with no real human text left after
 * cleaning. Such turns are hidden from the timeline by default.
 */
export function isNoisePrompt(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return true;
  }
  // Slash-command control turns.
  if (/^<command-name>/i.test(trimmed)) {
    return true;
  }
  // Pure local-command stdout/stderr/caveat with nothing else.
  if (
    /^<local-command-(stdout|stderr|caveat)>/i.test(trimmed) &&
    cleanPrompt(trimmed) === ""
  ) {
    return true;
  }
  // Anything that cleans down to empty (only IDE/system wrappers).
  if (cleanPrompt(trimmed) === "") {
    return true;
  }
  return false;
}

/** Shorten a raw model id for display, e.g. "copilot/claude-opus-4.5" -> "claude-opus-4.5". */
export function shortModel(model?: string): string | undefined {
  if (!model) {
    return undefined;
  }
  let m = model.trim();
  const slash = m.lastIndexOf("/");
  if (slash >= 0) {
    m = m.slice(slash + 1);
  }
  // Drop trailing date stamp like "-20251001".
  m = m.replace(/-20\d{6}$/, "");
  return m;
}

/** True when a turn had no consequence (no files, no edit/run actions). */
export function isInconsequential(turn: TraceTurn): boolean {
  if (turn.filesTouched.length > 0) {
    return false;
  }
  return !turn.actions.some((a) =>
    ["edit", "create", "delete", "run"].includes(a.kind)
  );
}

/** Per-file churn within a session: how many turns edited it, and any reversals. */
export interface FileChurn {
  relPath: string;
  edits: number;
  /** True when the same file was edited 3+ times (thrash signal). */
  thrash: boolean;
}

/** A session's roll-up: net effect, token cost, churn and model(s) used. */
export interface SessionAnalysis {
  sessionId: string;
  source: TraceSource;
  turnCount: number;
  /** Turns that actually changed something. */
  consequentialTurns: number;
  totalTokens: number;
  models: string[];
  files: FileChurn[];
  /** Files edited 3+ times in the session. */
  reworkFiles: string[];
  firstPrompt: string;
  lastTimestamp: string;
}

/**
 * Analyze a set of turns (already filtered to one workspace) into per-session
 * roll-ups that surface rework/churn — the "you went back and forth" signal a
 * plain timeline hides.
 */
export function analyzeSessions(turns: TraceTurn[]): SessionAnalysis[] {
  const bySession = new Map<string, TraceTurn[]>();
  for (const t of turns) {
    const arr = bySession.get(t.sessionId) ?? [];
    arr.push(t);
    bySession.set(t.sessionId, arr);
  }

  const out: SessionAnalysis[] = [];
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const editCounts = new Map<string, number>();
    let totalTokens = 0;
    let consequential = 0;
    const models = new Set<string>();
    for (const t of list) {
      totalTokens += (t.tokens.input ?? 0) + (t.tokens.output ?? 0);
      if (!isInconsequential(t)) {
        consequential++;
      }
      const sm = shortModel(t.model);
      if (sm) {
        models.add(sm);
      }
      for (const f of t.filesTouched) {
        editCounts.set(f, (editCounts.get(f) ?? 0) + 1);
      }
    }
    const files: FileChurn[] = Array.from(editCounts.entries())
      .map(([relPath, edits]) => ({ relPath, edits, thrash: edits >= 3 }))
      .sort((a, b) => b.edits - a.edits);

    out.push({
      sessionId,
      source: list[0].source,
      turnCount: list.length,
      consequentialTurns: consequential,
      totalTokens,
      models: Array.from(models),
      files,
      reworkFiles: files.filter((f) => f.thrash).map((f) => f.relPath),
      firstPrompt: list[0].prompt,
      lastTimestamp: list[list.length - 1].timestamp
    });
  }
  out.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  return out;
}
