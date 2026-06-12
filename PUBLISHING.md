# PUBLISHING.md — step-by-step: from this folder to GitHub + both marketplaces

_This file is for YOU (it's gitignored from the .vsix and excluded from the package;
it WILL be committed to GitHub unless you add it to .gitignore — it's safe either way,
it contains no secrets). Work top to bottom; don't skip the security steps._

---

## STEP 0 — Security sweep (do this FIRST, before `git init`)

The single unrecoverable mistake is committing a key. Everything else is fixable.

0.1  Rotate the exposed keys NOW.
     - Your Azure OpenAI key has lived in `api-keys.txt` and `.env` on disk.
       Treat it as burned: regenerate it in the Azure portal.
     - Do the same for any other key you ever pasted into this folder.

0.2  Confirm the ignore files are in place (already done by the prep work, verify):
     - `.gitignore` must contain: `.env`, `api-keys.txt`, `Dev/`, `dev/`, `.claude/`
     - `.vscodeignore` must contain: `api-keys.txt`, `.env`, `Dev/**`, `dev/**`, `.claude/**`

0.3  The `Dev/` backup folder contains a full copy INCLUDING `api-keys.txt`.
     It is gitignored — but double-check it never shows up in `git status` later.

0.4  Optional but recommended: move `Dev/` somewhere outside this folder entirely
     (e.g. `C:\Users\shreedhar\Backups\`). A backup inside the repo tree is one
     `.gitignore` edit away from being public.

---

## STEP 1 — Decide the name (blocks steps 2+)

> ✅ DECIDED: **Trace Your Code** (marketplace ID `trace-your-code`). The rename is
> already applied across package.json, README, and all user-visible strings.
> Still do 1.1–1.5 below to verify availability BEFORE first publish — the
> marketplace ID cannot change afterwards.

For the chosen name:

1.1  Search the VS Code Marketplace for collisions: https://marketplace.visualstudio.com
1.2  Search Open VSX: https://open-vsx.org
1.3  Check the GitHub repo name is free: https://github.com/<you>/<name>
1.4  Check npm (optional, future-proofing): https://www.npmjs.com/package/<name>
1.5  Check an available domain if you care (.dev/.io).

Then rename in code (ONE commit, do all together):
     - `package.json` → `"name"` (lowercase, hyphens — this is the marketplace ID,
       it CANNOT change after first publish), `"displayName"`, `"description"`
     - `README.md` → title line + anywhere "Change Tracker" appears
     - `CHANGELOG.md` → add a rename note
     - Optional: the settings prefix (`changeTracker.*`) and command IDs can stay —
       renaming them breaks users' settings and buys you nothing. Keep them.

---

## STEP 2 — Final code prep

2.1  Edit `package.json`, replace ALL placeholders:
     - `"publisher": "REPLACE-WITH-YOUR-PUBLISHER-ID"` → your real publisher ID
       (created in step 5.1)
     - `repository.url`, `bugs.url`, `homepage` → your actual GitHub URLs

2.2  Build clean and test:
     ```
     npm ci          (or: npm install)
     npm run compile
     npm test        → expect all tests passing
     ```

2.3  Smoke test in the Extension Development Host:
     - Open this folder in VS Code → F5 → open a real project in the dev window
     - Verify: timeline fills, Open Project Story works, Time Travel scrubs,
       AI toggle flow works, Undo turn works
     - Walk `CHECKLIST.md` for the checkpoint features

---

## STEP 3 — Create the GitHub repo and push

3.1  Create the repo on GitHub (public, NO auto-README/license — you have them):
     https://github.com/new

3.2  From this folder:
     ```
     git init
     git add .
     git status        ← READ THE LIST. Confirm you do NOT see:
                          api-keys.txt, .env, Dev/, .claude/, out/, node_modules/
     git commit -m "Initial public release"
     git branch -M main
     git remote add origin https://github.com/<you>/<repo>.git
     git push -u origin main
     ```

3.3  Post-push paranoia check (2 minutes, worth it):
     - Open the repo in a browser; search it for "CHANGE_TRACKER_API_KEY" and the
       first 8 chars of your (old, rotated) key. Must be zero hits outside docs.
     - If a key DID slip through: rotate it immediately (you already did in 0.1,
       right?), then rewrite history (`git filter-repo`) or nuke and recreate the
       repo — a force-push alone does not purge GitHub caches.

3.4  Repo settings:
     - Add topics: `vscode-extension`, `claude-code`, `ai-coding`, `developer-tools`
     - Description = the README's one-liner
     - Enable Issues; enable Discussions if you want a community channel

---

## STEP 4 — The demo GIF (the most important marketing asset)

4.1  Record 15–20 seconds on a small real project:
     prompt the AI → something breaks → Ask tab → "worked at turn X" →
     ranked suspect + diff → Undo turn → fixed.
     Tools: ScreenToGif (Windows, free) or Kap (mac). Keep under ~10 MB.

4.2  Save as `media/demo.gif`, uncomment the GIF line in README.md, commit, push.
     The marketplace renders the README — the GIF is your storefront.

---

## STEP 5 — Publish to the VS Code Marketplace

5.1  One-time setup:
     a. Create (or reuse) a Microsoft/Azure DevOps account: https://dev.azure.com
     b. Create a Personal Access Token (PAT):
        dev.azure.com → User settings → Personal access tokens → New
        - Organization: "All accessible organizations"
        - Scopes: Custom defined → Marketplace → ✅ Manage
        - Copy the token (shown once)
     c. Create your publisher: https://marketplace.visualstudio.com/manage
        → "Create publisher" → the ID you put in package.json
     d. Install the CLI: `npm install -g @vscode/vsce`

5.2  Package and inspect BEFORE publishing:
     ```
     vsce package
     vsce ls                      ← lists every file going into the .vsix.
                                    Confirm: NO api-keys.txt, NO .env, NO Dev/
     ```
     Also install the produced .vsix yourself in a clean VS Code profile and
     click around once.

5.3  Publish:
     ```
     vsce login <your-publisher-id>     (paste the PAT)
     vsce publish
     ```
     The listing appears in ~5–10 minutes at
     https://marketplace.visualstudio.com/items?itemName=<publisher>.<name>

5.4  Future releases: bump `"version"` in package.json (or `vsce publish patch|minor`),
     update CHANGELOG.md, `vsce publish`.

---

## STEP 6 — Publish to Open VSX (Cursor / Windsurf / VSCodium users)

This audience matters MORE for an AI-coding tool than the MS marketplace.

6.1  Create an account at https://open-vsx.org (GitHub login).
6.2  Generate an access token: your avatar → Settings → Access Tokens.
6.3  Sign the Eclipse publisher agreement when prompted (one-time, in-browser).
6.4  Create the namespace (must equal your publisher ID), then publish:
     ```
     npm install -g ovsx
     ovsx create-namespace <your-publisher-id> -p <token>
     ovsx publish <the-file>.vsix -p <token>
     ```
6.5  Future releases: `ovsx publish <new>.vsix -p <token>` after each `vsce package`.

---

## STEP 7 — Release hygiene on GitHub

7.1  Tag the release:
     ```
     git tag v0.3.0
     git push --tags
     ```
7.2  GitHub → Releases → "Draft a new release" → pick the tag, paste the
     CHANGELOG entry, attach the .vsix file (lets non-marketplace users install).

---

## STEP 8 — Launch (after everything above is live)

- Show HN — lead with the breakage-detective story, link the GIF.
- r/ClaudeAI, r/cursor, r/ChatGPTCoding, r/vscode — one per day, tailored hook:
  "Claude said it fixed it. The diff says otherwise."
- X/Twitter thread with the GIF.
- Respond to every issue within 24h for the first weeks — early responsiveness
  is what turns visitors into contributors.

---

## RECURRING RELEASE CHECKLIST (every version after this)

[ ] npm test green
[ ] CHANGELOG.md updated
[ ] version bumped in package.json
[ ] `vsce package` → `vsce ls` shows no secrets / no Dev/
[ ] install .vsix locally, 5-minute smoke test
[ ] `vsce publish` (MS) + `ovsx publish` (Open VSX)
[ ] git tag + GitHub release with .vsix attached
[ ] grep the repo for keys one more time. Paranoia is free; leaks are not.
+
