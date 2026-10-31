# Changed since you last looked

The viewer remembers which version of each file you last looked at and tells
you when the file on disk has changed since then. The history is kept by the
viewer server in its data dir, never inside the folder you browse.

## When a file counts as viewed

- Opening a file records it as viewed. On the first view there is nothing to
  compare with, so no banner appears.
- The version recorded is the one on screen when you **leave** the file: you
  open another file, close or hide the tab, or reload. On close or reload the
  browser limits the request to 64 KB, so for a bigger text the viewer sends
  only its SHA-256 (computed when the file loads); the server reads the file
  and keeps it as the saved copy only if it still hashes the same. If the file
  changed again in between, the version is recorded without a copy, so no
  text other than the one you saw is ever stored. If the file changes
  while it is open, the banner and the highlights update live. The newer
  version only becomes "seen" once you move on.
- Your own saves in the editor (`--allow-edit`) count as seen the moment they
  are saved, so they never produce a banner or a dot, however you leave the
  editor.
- A file counts as changed when its modification time or its size differs from
  the recorded version. If the text turns out to be identical (for example, the
  file was only touched or regenerated with the same bytes), no banner is
  shown and the new version counts as seen at once, so its dot goes away too.

## Sidebar

- A blue dot marks every file that changed since you last viewed it. The open
  file shows a ring instead until it counts as seen (when you leave it, or with
  **Mark as seen**). Folders get a dot on the folder icon when anything inside
  them changed, and the tooltip tells you how many files that is.
- The filter menu (funnel button) has a **Changes** section:
  - **Changed since viewed** shows only changed files (plus the open file).
    This also applies to the recent list and to the search results. While it
    is on, the number next to each folder is its count of changed files.
  - **Mark all as seen** clears every dot at once (the open file's banner
    too).
  - **Clear history…** forgets the folder's whole history, after a
    confirmation (see [below](#other-browsers-private-windows-clearing)).
- Files you have never opened get no dot. The feature is about changes to what
  you have already read, not about new files.
- Renames and moves seen by the live updates carry the history over, so a
  renamed file does not show up as changed.

## What's new

**What's new** at the top of the sidebar (or the `w` key) shows, in place of
the file tree, every file of the folder that changed since you last viewed it:
the same files that have a dot. The number next to it is how many there are.

- Newest change first (by modification time). Each row shows the file name,
  its folder, when it changed and the same summary as the banner
  (`2 added · 1 edited`, `3 changes, +5 −2 lines`, `grew by 2.0 KB`, …). A file
  that was rewritten with the same text shows `same text, only rewritten`; it
  counts as seen once you open it.
- The summaries are computed only for the rows on screen, a few at a time, and
  kept per version of the file, so a folder with hundreds of changed files
  stays fast. Rows further down show a placeholder until you scroll to them.
- Click a row to open the file, with the banner and the highlights as usual.
  The list stays open, so you can go through it file by file.
- The check mark on a row (on hover) marks that file as seen; **Mark all as
  seen** does it for the whole list. Both offer **Undo** for a moment. Marking
  the open file removes its banner too.
- The list is live: rows appear, update and disappear as files change and as
  other tabs or browsers mark files as seen.
- `w` (or the arrow at the top) goes back to the file tree. The filter box is
  hidden while the list is shown; the file type filter does not apply to it.
- When the folder is inside a git repository (see [Git](git.md)), the panel
  has two tabs: **Changed since viewed** (this list) and **Uncommitted** (files
  with changes since the last commit, with their git status and +/- lines;
  see [Uncommitted](git.md#uncommitted)). The count next to What's new is the
  changed-since-viewed count.
- When the feature is off (see [below](#where-the-data-lives)), What's new
  shows only the Uncommitted list in a git repository, and there is no What's
  new entry otherwise.

## The banner

Opening a changed file shows a slim banner under the header: "Changed since
your last visit (5 min ago)", followed by what changed:

| File | Detail |
|---|---|
| Markdown | `2 added · 1 edited · 1 removed` (top-level blocks: paragraphs, headings, lists, tables, code blocks), in the colours of the highlights |
| Other text, or markdown where only link/footnote definitions changed | `N changes, +A −R lines` |
| Whitespace only | `only whitespace changed` |
| Binary, image, or text without an earlier copy | `grew by 2.0 KB` / `shrank by …` / `size unchanged` |
| Text over 2 MB | `grew by 3.1 MB · too large to compare` |

- Click the detail to jump to the first change; the up/down arrows (or the
  `n` / `p` keys) go to the next and previous change, in the article or in the
  diff.
- **Show changes** opens a unified line diff (the last viewed version against
  the current one) in place of the file. Edited lines show the changed words
  highlighted. Click a "N unchanged lines" row to show those lines. **Hide
  changes** goes back.
- **Mark as seen** accepts the current version and removes the banner and the
  highlights. A toast offers **Undo** for a moment.
- In a git repository the banner has a **Since last viewed** / **Since last
  commit** switch; the second compares with the last commit instead (see
  [Git](git.md#since-last-commit)).

## Markdown highlights

In rendered markdown, changed blocks are marked in the left margin:

- green: a new block;
- amber: a modified block;
- a dashed red line with "N blocks removed" where blocks used to be (or
  "… at the end" after the last block).

The highlights do not appear in print or in the PDF export.

## Where the data lives

The server keeps the history in one SQLite file, `seen.sqlite3`, in its data
dir (the same folder as `state.json`: `--data-dir` / `DOCS_VIEWER_DATA_DIR`,
by default `.data/` in the checkout; the desktop app uses `<userData>/data`).
Records are keyed by the full path of the root folder, so two root folders
never share history. The diffing and the highlights still happen in the
browser; the server only stores what you last saw.

- One small "seen" record per viewed file (mtime, size, time viewed). At most
  20,000 per root; the oldest go first.
- A copy of the text as you last saw it, for text files up to 2 MB, so the diff
  and the highlights work. The oldest copies (across all roots) are dropped
  beyond 1,000 copies or 64 M characters in total. If the disk is full, older
  copies are dropped and the newest record is kept without its text.
- Every tab and every browser on the same server shares the history: a change
  in one shows up in the others at once (a `seen` event on the live-update
  stream).
- Read-only mode never writes inside the folder. If the data dir is inside the
  root (or the root inside the data dir), the feature switches itself off for
  that folder: no dots, no banner, no Changes section. It also switches off if
  the database cannot be opened (for example, the data dir is not writable).
- The endpoints are described in [Security model](security.md#the-apiseen-endpoints).

## Other browsers, private windows, clearing

- The history belongs to the server's data dir, not to a browser profile:
  another browser or a private window on the same machine sees the same
  history, and clearing the browser's site data does not reset it. A viewer
  started with another `--data-dir` starts fresh.
- **Mark all as seen** (filter menu > Changes) clears every dot of the current
  folder.
- **Clear history…** (filter menu > Changes) asks for confirmation, then
  deletes every seen record and saved copy of the current folder (other
  folders keep theirs). All dots and banners go away, in every tab and browser
  on the server. Files count as never opened again; the file open at that
  moment becomes the new baseline, as on a first view.
- To forget the history of every folder, stop the viewer and delete
  `seen.sqlite3` (and `seen.sqlite3-wal` / `seen.sqlite3-shm` if present) from
  the data dir. It is recreated empty on the next start.
- The desktop app keeps the history in `<userData>/data/seen.sqlite3` (see
  [Desktop app](desktop.md)), so it survives restarts and port changes. Help >
  **Open Data Folder** shows the file.
