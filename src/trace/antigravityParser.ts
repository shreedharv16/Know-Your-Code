import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import {
  TraceAction,
  TraceTurn,
  TokenUsage,
  computeRisk,
  cleanPrompt,
  isNoisePrompt
} from "./traceTypes";

/** Normalize for cross-platform path comparison. */
function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

function toRel(root: string, abs: string): string | undefined {
  if (!abs) {
    return undefined;
  }
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined; // outside the workspace
  }
  return rel.replace(/\\/g, "/");
}

function classifyTool(tool: string): TraceAction["kind"] {
  const t = tool.toLowerCase();
  if (t.includes("replace") || t.includes("edit")) return "edit";
  if (t === "write_to_file" || t === "create") return "create";
  if (t.includes("delete") || t.includes("remove")) return "delete";
  if (t.includes("view") || t.includes("read") || t.includes("list")) return "read";
  if (t.includes("search")) return "search";
  if (t.includes("run") || t.includes("command")) return "run";
  return "other";
}

function extractFilePath(toolName: string, args: Record<string, any>): string | undefined {
  if (args.TargetFile) return args.TargetFile;
  if (args.AbsolutePath) return args.AbsolutePath;
  if (args.SearchPath) return args.SearchPath;
  if (args.DirectoryPath) return args.DirectoryPath;
  if (args.Cwd) return args.Cwd;
  return undefined;
}

export async function parseAntigravity(rootFsPath: string): Promise<TraceTurn[]> {
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity-ide", "brain");
  if (!fs.existsSync(brainDir)) {
    return [];
  }
  const wanted = normPath(rootFsPath);
  const turns: TraceTurn[] = [];

  let convDirs: fs.Dirent[];
  try {
    convDirs = await fsp.readdir(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dir of convDirs) {
    if (!dir.isDirectory()) continue;
    const sessionId = dir.name;
    const transcriptPath = path.join(brainDir, sessionId, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(transcriptPath)) continue;

    let text: string;
    try {
      text = await fsp.readFile(transcriptPath, "utf8");
    } catch {
      continue;
    }

    const records: any[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // skip malformed line
      }
    }

    if (records.length === 0) continue;

    const sessionTurns = groupSession(records, rootFsPath, sessionId, wanted);
    turns.push(...sessionTurns);
  }

  turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return turns;
}

function groupSession(records: any[], root: string, sessionId: string, wantedPath: string): TraceTurn[] {
  const out: TraceTurn[] = [];
  let current: TraceTurn | undefined;
  let turnIndex = 0;
  let hasWorkspaceAction = false;

  const finalize = () => {
    if (current && hasWorkspaceAction) {
      current.filesTouched = Array.from(
        new Set(
          current.actions
            .filter((a) => ["edit", "create", "delete"].includes(a.kind))
            .map((a) => a.relPath)
            .filter((p): p is string => !!p)
        )
      );
      current.risk = computeRisk(current.filesTouched);
      out.push(current);
    }
    current = undefined;
    hasWorkspaceAction = false;
  };

  for (const rec of records) {
    if (rec.type === "USER_INPUT") {
      finalize();
      const rawUserText = rec.content || "";
      if (isNoisePrompt(rawUserText)) {
        continue;
      }
      current = {
        id: `antigravity:${sessionId}:${turnIndex++}`,
        source: "antigravity",
        sessionId,
        timestamp: rec.created_at ?? new Date().toISOString(),
        prompt: cleanPrompt(rawUserText).slice(0, 400),
        actions: [],
        filesTouched: [],
        tokens: { input: 0, output: 0 }
      };
      hasWorkspaceAction = false; // We don't know yet if this turn touches the workspace
      continue;
    }

    if (rec.type === "PLANNER_RESPONSE" && current) {
      if (rec.thinking) {
        current.reasoning = (current.reasoning ? current.reasoning + "\n" : "") + rec.thinking;
        // Truncate if too long
        if (current.reasoning.length > 2000) {
           current.reasoning = current.reasoning.slice(0, 2000);
        }
      }
      
      if (Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls) {
          const toolName = tc.name ?? "tool";
          const kind = classifyTool(toolName);
          const args = tc.args ?? {};
          
          let relPath: string | undefined;
          let detail: string | undefined;

          const rawFilePath = extractFilePath(toolName, args);
          if (rawFilePath) {
            const cleanPath = typeof rawFilePath === 'string' ? rawFilePath.replace(/^['"]|['"]$/g, '') : "";
            if (normPath(cleanPath).startsWith(wantedPath)) {
               hasWorkspaceAction = true;
               relPath = toRel(root, cleanPath) ?? cleanPath.replace(/\\/g, "/");
            }
          }

          if (kind === "run" && typeof args.CommandLine === "string") {
            detail = args.CommandLine.slice(0, 200);
          } else if (kind === "search" && typeof args.Query === "string") {
            detail = args.Query.slice(0, 200);
          }

          current.actions.push({ kind, tool: toolName, relPath, detail });
        }
      }
      
      if (rec.created_at) {
        current.timestamp = rec.created_at;
      }
    }
  }

  finalize();
  return out;
}
