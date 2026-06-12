import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";
import {
  TraceData,
  TraceTurn,
  TraceSource,
  TurnSnapshot,
  TRACE_VERSION
} from "./traceTypes";
import { parseClaudeCode } from "./claudeCodeParser";
import { parseCopilotChat } from "./copilotChatParser";
import { parseAntigravity } from "./antigravityParser";
import { ShadowRepo } from "./shadowRepo";
import { extractCodeFacts } from "./codeFacts";

/**
 * Orchestrates parsing both assistants' logs, merging with previously stored
 * turns (so LLM summaries/explanations survive re-parses), persisting to local
 * disk, and — new in v0.2 — recording a shadow-git snapshot per turn so every
 * chapter of the project's story has real, diffable evidence attached.
 *
 * Storage: <extension storageUri>/trace.json + <storageUri>/shadow.git.
 * Nothing here touches the project's own git or leaves the machine (except
 * the optional summarizer, which the user explicitly enables).
 */
export class TraceService {
  private data: TraceData;
  private readonly traceUri: vscode.Uri | undefined;
  private readonly chatSessionsDir: string | undefined;
  /** The time-machine backend. Undefined when no workspace/storage. */
  readonly shadow: ShadowRepo | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const storage = context.storageUri;
    if (storage) {
      this.traceUri = vscode.Uri.joinPath(storage, "trace.json");
    }
    this.chatSessionsDir = deriveChatSessionsDir(storage);
    const root = this.rootFsPath();
    if (storage && root) {
      this.shadow = new ShadowRepo(
        path.join(storage.fsPath, "shadow.git"),
        root
      );
    }
    this.data = {
      version: TRACE_VERSION,
      root: root ?? "",
      turns: [],
      snapshots: {}
    };
  }

  private rootFsPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  get turns(): TraceTurn[] {
    return this.data.turns;
  }

  /** Shadow snapshot for a turn, if one was recorded. */
  snapshotFor(turnId: string): TurnSnapshot | undefined {
    return this.data.snapshots?.[turnId];
  }

  /** Load persisted trace from disk (call once on activation). */
  async load(): Promise<void> {
    if (!this.traceUri) {
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(this.traceUri);
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as TraceData;
      if (parsed && parsed.version === TRACE_VERSION && parsed.turns) {
        this.data = parsed;
        this.data.snapshots = this.data.snapshots ?? {};
      }
    } catch {
      // no trace yet — fine
    }
  }

  private async save(): Promise<void> {
    if (!this.traceUri) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(
        this.traceUri,
        Buffer.from(JSON.stringify(this.data, null, 2), "utf8")
      );
    } catch {
      // best-effort persistence
    }
  }

  /**
   * Re-parse both sources, merge, and snapshot new turns into the shadow repo.
   * Existing turns' summaries/explanations are preserved when the turn's
   * content hasn't changed (matched by id + summaryKey).
   */
  async refresh(sources?: TraceSource[]): Promise<TraceTurn[]> {
    const root = this.rootFsPath();
    if (!root) {
      return this.data.turns;
    }
    const want = new Set<TraceSource>(
      sources ?? ["claude-code", "copilot-chat", "antigravity"]
    );

    const fresh: TraceTurn[] = [];
    if (want.has("claude-code")) {
      try {
        fresh.push(...(await parseClaudeCode(root)));
      } catch {
        // ignore parser failure for one source
      }
    }
    if (want.has("copilot-chat")) {
      try {
        fresh.push(
          ...(await parseCopilotChat(root, this.chatSessionsDir))
        );
      } catch {
        // ignore
      }
    }
    if (want.has("antigravity")) {
      try {
        fresh.push(...(await parseAntigravity(root)));
      } catch {
        // ignore
      }
    }

    // Preserve LLM output + facts from the previous run where content is unchanged.
    const prevById = new Map(this.data.turns.map((t) => [t.id, t]));
    for (const turn of fresh) {
      const key = summaryKey(turn);
      turn.summaryKey = key;
      const prev = prevById.get(turn.id);
      if (prev && prev.summaryKey === key) {
        if (prev.summary) {
          turn.summary = prev.summary;
        }
        if (prev.explanation) {
          turn.explanation = prev.explanation;
        }
        if (prev.facts) {
          turn.facts = prev.facts;
        }
      }
    }

    fresh.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const snapshots = this.data.snapshots ?? {};
    this.data = { version: TRACE_VERSION, root, turns: fresh, snapshots };

    await this.recordSnapshots(fresh, snapshots);
    await this.save();
    return fresh;
  }

  /**
   * Shadow-git bookkeeping: turns that predate the repo share one "baseline"
   * snapshot; each refresh that brings genuinely new turns gets one commit of
   * the current working tree, attributed to those turns. Structural code facts
   * are mined from the real diff right here (no LLM involved).
   */
  private async recordSnapshots(
    turns: TraceTurn[],
    snapshots: Record<string, TurnSnapshot>
  ): Promise<void> {
    const shadow = this.shadow;
    if (!shadow) {
      return;
    }
    const enabled = vscode.workspace
      .getConfiguration("changeTracker")
      .get<boolean>("shadow.enabled", true);
    if (!enabled || !(await shadow.init())) {
      return;
    }

    const newTurns = turns.filter((t) => !snapshots[t.id]);
    if (newTurns.length === 0) {
      return;
    }

    const isFirstRun = Object.keys(snapshots).length === 0;
    if (isFirstRun) {
      // Baseline: everything that already happened is "history before the
      // camera was rolling" — one snapshot, no per-turn diffs available.
      const base = await shadow.commitSnapshot("baseline (Trace Your Code installed)");
      if (!base) {
        return;
      }
      for (const t of newTurns) {
        snapshots[t.id] = {
          commit: base.commit,
          parent: base.parent,
          changed: false,
          historical: true
        };
      }
      return;
    }

    // Genuinely-new activity since the last refresh → one commit for the batch.
    const newest = newTurns[newTurns.length - 1];
    const label = (newest.prompt || newest.id).slice(0, 72);
    const tc = await shadow.commitSnapshot(`turn ${newest.id}: ${label}`);
    if (!tc) {
      return;
    }
    for (const t of newTurns) {
      snapshots[t.id] = {
        commit: tc.commit,
        parent: tc.parent,
        changed: tc.changed
      };
    }
    // Mine structural facts from the real diff and pin them on the newest turn.
    if (tc.changed && tc.parent) {
      try {
        const diff = await shadow.diffOfTurn(tc);
        if (diff) {
          const facts = extractCodeFacts(diff);
          if (facts.added.length || facts.removed.length) {
            newest.facts = facts;
          }
        }
      } catch {
        // facts are best-effort
      }
    }
  }

  /** Persist a freshly computed summary for one turn. */
  async setSummary(id: string, summary: string): Promise<void> {
    const turn = this.data.turns.find((t) => t.id === id);
    if (turn) {
      turn.summary = summary;
      await this.save();
    }
  }

  /** Persist a grounded explanation for one turn. */
  async setExplanation(id: string, explanation: string): Promise<void> {
    const turn = this.data.turns.find((t) => t.id === id);
    if (turn) {
      turn.explanation = explanation;
      await this.save();
    }
  }

  /** Turns that still have no summary (for batch summarization). */
  unsummarized(): TraceTurn[] {
    return this.data.turns.filter((t) => !t.summary && t.prompt);
  }
}

/** Cache key: changes when the turn's salient content changes. */
function summaryKey(turn: TraceTurn): string {
  const h = createHash("sha1");
  h.update(turn.prompt);
  h.update("\u0000");
  h.update(turn.filesTouched.join(","));
  h.update("\u0000");
  h.update(turn.actions.map((a) => a.kind + ":" + (a.relPath ?? a.tool)).join("|"));
  return h.digest("hex");
}

/**
 * The chatSessions folder for THIS workspace sits next to the extension's own
 * storage: <workspaceStorage>/<hash>/<ext>/  ->  <workspaceStorage>/<hash>/chatSessions/
 */
function deriveChatSessionsDir(
  storage: vscode.Uri | undefined
): string | undefined {
  if (!storage) {
    return undefined;
  }
  const hashDir = path.dirname(storage.fsPath); // <workspaceStorage>/<hash>
  const candidate = path.join(hashDir, "chatSessions");
  return fs.existsSync(candidate) ? candidate : candidate; // return even if not yet present
}
