# udrop file listing — no external backend, GitHub-only

Everything runs inside your existing GitHub Actions workflow. No
Cloudflare/Netlify/Vercel account needed, and your udrop API keys never
leave GitHub's secret store.

## How it works

Every time the scheduled job runs and detects a change:

1. It lists your udrop account/folder via the API.
2. For every file, it calls `/file/download` once and stores the real
   direct-download URL in `files.json`.
3. For every folder (and the account root), it downloads all the files in
   that folder+subfolders and zips them locally, then uploads the zip as
   an asset on a fixed GitHub Release (tag `file-zips`).
4. It commits the updated `files.json`, which now has a `downloadUrl` per
   file and a `zipAsset` per folder — both just plain static links.

The page (`index.html`) only ever reads `files.json` and links straight to
those URLs. No JavaScript talks to udrop, and there's nothing running at
request time — the "backend" work already happened during the sync.

## Setup

1. Replace these four files in your existing repo with the versions here:
   - `scripts/sync.js`
   - `.github/workflows/sync.yml`
   - `index.html`
   - `package.json` (new — installs `archiver`, used to build the zips)
2. Your existing `UDROP_KEY1` / `UDROP_KEY2` repo secrets don't need to
   change. Nothing else to configure — `GITHUB_TOKEN` is provided
   automatically by Actions.
3. Commit, push, then trigger it once by hand: Actions tab → "Sync file
   list" → Run workflow.
4. Check the repo's **Releases** page — you should see a release tagged
   `file-zips` with a `.zip` per folder. Check `files.json` — files should
   now have a `downloadUrl`, folders a `zipAsset`.
5. Open the site: clicking a file should download it immediately; clicking
   "zip" next to a folder should download that folder as a `.zip`
   immediately. No udrop page in between either way.

## Update: file links now refresh every run

Earlier version of this script only rewrote `files.json` when a file was
added/removed/renamed — which meant download links (which use udrop's
short-lived tokens) went stale and 404'd once the original token expired,
even though the folder zips kept working fine (zips are real bytes, not
links, so they don't expire). Fixed: every run now always refreshes every
file's link. The (expensive) zip rebuild is still skipped unless the
folder's actual contents changed, so this doesn't slow things down.

**Trade-off:** since a fresh token differs from the last one even when
nothing else changed, `files.json` now gets committed on essentially every
5-minute run, not just when files change. That's a lot of small commits
over time (roughly 288/day) — harmless functionally, just noisier history.
If that bothers you later, options are: run the sync less often (e.g. every
30–60 min, trading off how quickly a dead link gets fixed), or switch to
committing `files.json` on an orphan/data branch instead of `main` to keep
your main history clean — happy to set either up if you want it.

## Update: multiple udrop accounts

You can now pull from more than one udrop account into the same site. Each
account shows up as its own top-level folder, named however you like.

1. In your repo: **Settings → Secrets and variables → Actions**.
2. Under **Variables**, add `UDROP_ACCOUNT_NAMES` with a comma-separated
   list of display names, e.g.:
   ```
   School Drive, Personal Archive
   ```
3. Under **Secrets**, for each account in that list (1-based position), add:
   - `UDROP_KEY1_1` / `UDROP_KEY2_1` — for "School Drive"
   - `UDROP_KEY1_2` / `UDROP_KEY2_2` — for "Personal Archive"
   - and so on.
4. Optional: to scope an account to one folder instead of its whole drive,
   add a **Variable** `UDROP_ROOT_1` (etc.) with that folder's id.
5. The included workflow already wires up slots 1–4. If you need a 5th
   account, add three more `env:` lines to `sync.yml` following the same
   `_5` pattern.
6. Leave your old `UDROP_KEY1`/`UDROP_KEY2` secrets in place — they're
   simply ignored once `UDROP_ACCOUNT_NAMES` is set.
7. Run the workflow by hand once. Each account should appear as a
   top-level folder on the site, each downloadable individually as a zip —
   and the account root's zip button zips across *every* account at once.

## Update: uploadg.com account (read-only, ad pages kept intact)

A uploadg account works alongside udrop ones in the same site — it becomes
its own top-level folder, just like a udrop account. This integration only
**lists** files/folders and links to **uploadg's own share pages** — it
never fetches file bytes, so uploadg's ad-gated download page (for files)
and folder-zip page (for folders) are never bypassed; your/the uploader's
pay-per-download earnings are unaffected either way:

- Each **file** links to its own uploadg share page (ad, then download).
- Each **folder**'s "zip" button links to *that folder's* uploadg share
  page too — uploadg's own folder pages already have a native "download
  whole folder" option, so we point at that instead of building our own.
- The one exception is the site's global "zip everything" root button —
  that one's built by us (bytes downloaded + zipped + hosted on a GitHub
  Release), so it only ever includes udrop-sourced files. There's no
  single uploadg entry that represents "your whole account" to share, so
  there's nothing to link the root button to for uploadg's side — if you
  want all of a uploadg account zippable at once, share its outermost
  folder from the uploadg dashboard and browse into that folder on the
  site to use its zip button directly.

The share-link format (`https://uploadg.com/drive/s/{hash}`) has been
confirmed against a real link — no setup needed there. If it ever changes
on uploadg's end, override it with a repo **Variable**
`UPLOADG_SHARE_URL_TEMPLATE` (must contain `{hash}`).

### Setup (one account)

1. **Settings → Secrets and variables → Actions → Variables** → add
   `UPLOADG_ACCOUNT_NAMES` = `Music` (or whatever name you want it to show
   as on the site).
2. **Secrets** → add `UPLOADG_TOKEN_1` (API token from uploadg's Account
   Settings → Developers).
3. Optional: a **Variable** `UPLOADG_ROOT_1` to scope it to one folder
   instead of the whole drive.
4. Run the workflow by hand, then click a uploadg file — it should land on
   that file's uploadg share page — and a uploadg folder's "zip" button —
   it should land on that folder's uploadg share page.

## Things worth knowing

- **Every run that finds a change re-downloads every file and rebuilds
  every zip**, even if only one file changed — there's no per-folder diff.
  For a modest drive of scripts/PDFs this is quick; for a large one it'll
  make the Action noticeably slower (and use more of your Actions minutes).
  If that becomes a problem, the fix is per-folder change detection, which
  I can add later.
- The release marked `file-zips` is managed entirely by the script —
  assets get deleted and re-uploaded each run. Don't attach anything else
  to it by hand, it'll get overwritten.
- `/file/download` links are generated fresh each sync, but how long udrop
  keeps them valid isn't documented. If you ever see a file link stop
  working between syncs, the fix is to run the workflow by hand to refresh
  it — worth keeping an eye on for the first few days.
- GitHub disables scheduled workflows after 60 days of no repo activity —
  same as before, nothing new here.
- Anything published this way is downloadable by anyone with the link —
  keep private files out of the synced folder, same as before.
