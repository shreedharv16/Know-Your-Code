# Trace Your Code — the AI Coding Time Machine

> Every prompt becomes a chapter. See what your AI assistant **actually** changed,
> scrub any file back through time, undo any turn, and ask
> *"what broke since it last worked?"* — all grounded in real diffs, never chat claims.

<!-- DEMO GIF — record per PUBLISHING.md step 4, then uncomment:
![demo](media/demo.gif)
-->

**Local-only. No account. No telemetry. Works with no API key.**
An optional AI-narration layer (bring your own key — OpenAI, Anthropic, Gemini,
OpenRouter, Azure OpenAI, or any OpenAI-compatible endpoint) adds plain-English
explanations on top.

---

## Why this exists

Vibe coding is real: you prompt Claude Code / Copilot / an agent, it builds, you move on.
Ten prompts later something breaks — and nobody reads the logs. Worse, the assistant's
*"here's what I built"* summary is the model describing its own work, so it can be wrong
or incomplete.

Trace Your Code ignores descriptions entirely. It watches **what actually landed on
disk**, ties every change back to **the prompt that caused it** (including the model's
reasoning), and lets you walk the whole story backwards — like a flight recorder for
your codebase.

## What you get

![Screenshot 1](img/img1.jpeg)
![Screenshot 2](img/img2.jpeg)
![Screenshot 3](img/img3.jpeg)
![Screenshot 4](img/img4.jpeg)

### 📖 Project Story (dashboard)
A local dashboard (`Trace Your Code: Open Project Story`) with the full narrative:

- **Story** — chronological chapters: prompt → the model's reasoning ("what was it
  thinking?") → its response → the **real diff** → which functions appeared/disappeared.
- **Time Travel** — pick any file in a tree of your project, scrub a slider through
  every turn that touched it, view the diff of each step or the entire file as it was
  before/after any point.
- **Files** — churn map: which files the AI reworks the most (3+ edits in one session
  is flagged as possible rework/thrash).
- **Ask** — the breakage detective: *"it still worked at turn X"* → get every file that
  changed since, the full cumulative diff, and (with AI narration on) ranked suspects
  with reasons.
- **Export report** — turn the visible story into a Markdown changelog / standup notes,
  generated from what actually happened.
- Light/dark/auto theme, search, per-assistant filters.

### ⏱ Activity Timeline (VS Code panel)
A slim panel in the activity bar: every prompt turn from Claude Code and Copilot Chat,
auto-detected from their local logs. Expand a turn for files touched, function-level
facts, and three buttons: **View diff** (before↔after in the diff editor),
**Explain** (AI), **Undo turn** (restore those files to their pre-turn state).

### ✅ Checkpoint review (the classic)
Take a checkpoint, let the AI edit, then Accept / Reject each changed file against a
real filesystem diff. Tool-agnostic: it diffs the disk, so it catches edits from any
agent, script, or human.

## How the time machine works (and why it's safe)

Trace Your Code keeps a **shadow git repository** whose `.git` directory lives in the
extension's own storage folder — **not** in your project. Every detected AI turn becomes
one shadow commit, giving you per-turn diffs, file history, and one-click restore.

- Your project folder gains **zero new files**.
- Your real `.git` (if any) is never read, never written, never touched.
- The project's `.gitignore` is respected (plus defaults: `node_modules`, `dist`, …).
- Requires `git` on your PATH; without it the tracker still works, you just lose
  per-turn snapshots.
- Turns that happened before installation are labeled *pre-install* (the story exists,
  the snapshot evidence doesn't).

## Install

**From the marketplace:** search for the extension name in VS Code's Extensions view
(also published on [Open VSX](https://open-vsx.org) for Cursor / Windsurf / VSCodium).

**From a .vsix:**

```bash
npm install
npm run compile
npx vsce package        # produces the .vsix
```

Then Extensions panel → `…` → **Install from VSIX…**

**From source (development):** open this folder in VS Code, `npm install`,
`npm run compile`, press **F5**.

## Quick start

1. Open your project in VS Code. The **Trace Your Code** icon appears in the activity bar.
2. Use Claude Code / Copilot Chat as usual — turns appear in the timeline automatically.
3. Click **Open Project Story** for the dashboard.
4. Something broke? **Ask** tab → pick the last good turn → see exactly what changed.
5. Want a chapter gone? **Undo turn** restores those files to their pre-turn state.

No setup, no checkpoint discipline, no API key required for any of the above.

## AI narration (optional, bring your own key)

Off by default — and stays off until you explicitly flip the toggle, even if a key
exists on disk. When enabled it adds:

- **Explain this change** — 3–6 grounded sentences per turn: what changed, why, what to
  double-check. Derived from the real diff + the model's own reasoning.
- **File stories** — a biography of any file across its chapters.
- **Ranked breakage suspects** in the Ask tab.

### Supported providers

| Provider | Key from | Default model | Endpoint needed? |
|---|---|---|---|
| OpenAI | platform.openai.com | `gpt-4o-mini` | no |
| Anthropic (Claude) | console.anthropic.com | `claude-haiku-4-5-20251001` | no |
| Google Gemini | aistudio.google.com | `gemini-2.5-flash` | no |
| OpenRouter | openrouter.ai | `openai/gpt-4o-mini` | no |
| Azure OpenAI | your Azure resource | (your deployment) | yes |
| Custom (OpenAI-compatible) | Groq, Together, Mistral, DeepSeek, Ollama, … | (yours) | yes |

### Setup

Flip the **AI narration** toggle in the timeline panel (or the dashboard header) — a
guided flow asks for provider → key → model → endpoint (only when needed) and writes
them to **`api-keys.txt`** at your workspace root:

```ini
CHANGE_TRACKER_PROVIDER=openai
CHANGE_TRACKER_API_KEY=sk-...
CHANGE_TRACKER_MODEL=          # empty = provider default
CHANGE_TRACKER_ENDPOINT=       # azure-openai / custom only
```

`api-keys.txt` is **gitignored** — never commit it, and rotate any key that leaks.
Keys are never stored inside VS Code and are sent only to the provider you configured.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `changeTracker.include` | `**/*` | Files to snapshot at checkpoint time. |
| `changeTracker.exclude` | `node_modules`, `.git`, `dist`, … | Files to ignore. |
| `changeTracker.maxFileSizeKB` | `1024` | Larger files are skipped. |
| `changeTracker.autoRefresh` | `true` | Re-scan when files change on disk. |
| `changeTracker.shadow.enabled` | `true` | Per-turn shadow-git snapshots (the time machine). |
| `changeTracker.trace.summarize` | `false` | **Master AI-narration toggle.** A key alone never enables it. |
| `changeTracker.trace.provider` | *(from api-keys.txt)* | `openai` / `anthropic` / `gemini` / `openrouter` / `azure-openai` / `custom`. |
| `changeTracker.trace.model` | *(provider default)* | Model or Azure deployment name. |
| `changeTracker.trace.endpoint` | — | Only for `azure-openai` / `custom`. |
| `changeTracker.trace.sendDiffsToLLM` | `false` | Include diff content in *bulk* summaries. Explicit per-turn actions always use the real diff. |

## Privacy

- Everything is stored on your machine, in the extension's per-workspace storage.
- **Zero network requests** unless you explicitly enable AI narration — and then only
  direct calls to the provider you configured, with the content shown above.
- No telemetry, no analytics, no accounts.
- The dashboard binds to `127.0.0.1` on an ephemeral port — nothing is exposed off-box.
- The source is MIT-licensed and small enough to audit in an afternoon. Please do.

## Limitations

- **Single workspace folder** (first folder of a multi-root workspace).
- **Text files only** — binaries and files over the size limit are skipped.
- Turn detection parses Claude Code / Copilot Chat **local logs**; if a log format
  changes upstream, the timeline may go quiet until the parser is updated —
  [file an issue](../../issues) and it'll be fixed fast.
- Several turns landing within one refresh window share one snapshot (the diff is
  attributed to the batch).

## Project layout

```
src/extension.ts                       activation, commands, watchers, time-machine handlers
src/baselineStore.ts                   checkpoint snapshot persistence
src/changeModel.ts                     checkpoint diff engine
src/webviewProvider.ts                 changed-files panel
src/baselineContentProvider.ts         checkpoint content for the diff editor
src/diffUtil.ts                        +added / -removed line counting
src/trace/traceTypes.ts                turn/session data model, churn analysis
src/trace/claudeCodeParser.ts          Claude Code JSONL log parser
src/trace/copilotChatParser.ts         Copilot Chat log parser
src/trace/traceService.ts              parse + merge + per-turn shadow snapshots
src/trace/shadowRepo.ts                shadow git engine (isolated --git-dir)
src/trace/shadowContentProvider.ts     any-commit file content for the diff editor
src/trace/codeFacts.ts                 structural function/class facts from diffs
src/trace/envConfig.ts                 multi-provider key file reader
src/trace/summarizer.ts                AI narration (Explain / Story / Investigate)
src/trace/traceViewProvider.ts         Activity Timeline panel
src/trace/dashboardServer.ts           Project Story dashboard (local HTTP)
```

`npm test` runs the unit tests (Node's built-in runner, no extra dependencies).

## Contributing

PRs welcome — parsers for more agents (Cursor, Codex CLI, Gemini CLI, Aider) are the
most wanted contribution. See [CONTRIBUTING.md](CONTRIBUTING.md) (sign-off required, DCO).

## License

[MIT](LICENSE).
