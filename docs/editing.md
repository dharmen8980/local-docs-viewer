# Editing (opt-in)

```sh
uv run viewer --allow-edit                       # or DOCS_VIEWER_ALLOW_EDIT=1 uv run viewer
uv run viewer --allow-edit --data-dir ~/ldv-data  # keep history/trash elsewhere
```

Without the flag the viewer behaves exactly as before: no edit UI is shown,
every `/api/edit/*` request (any method) returns 403 `{"detail":"editing
disabled"}` and nothing in the docs folder can change (the data dir only
receives `state.json`, the remembered folders). With the
flag the header shows an **Editing enabled** badge and the server logs
`EDITING ENABLED` with the data dir path.

> **Important: if the folder you edit has no git history** (for example a
> git-ignored working folder), the viewer's data dir (`.data/` by default) is the only safety net
> for changes made from the browser: version history and Trash live there.
> Back it up before deleting it (see [Backing up and clearing the data
> dir](#backing-up-and-clearing-the-data-dir)).

What you can do in the browser:

- **Edit** (header button) for markdown, mermaid, code, JSON, CSV and text
  files up to 2 MB. CodeMirror 6 (bundled, loaded only when you click Edit)
  with syntax highlighting, line numbers, a wrap toggle and find/replace
  (Cmd/Ctrl-F). Markdown and `.mmd` open side by side with a live preview
  (about 300 ms delay); the toolbar switches between editor / split / preview.
  **Cmd/Ctrl-S** saves (pressed during a save, it saves again once that one
  finishes); **Esc** anywhere in the editor view (editor, toolbar, banners;
  not while a menu, dialog or the find panel is open) or **Done** leaves the
  editor.
- **Unsaved changes** show as a dot in the header and a `●` in the tab title.
  Closing the tab warns; tree clicks, search jumps, links and Back/Forward ask
  *Save / Discard / Cancel*.
- **JSON** is checked before saving (line and column of the error); *Save
  anyway* writes it regardless.
- **Conflicts:** saves send the hash of the text the editor loaded. If the file
  changed on disk in the meantime (the server answers 409, or a live update
  arrives while you have unsaved edits) a banner offers *Overwrite with mine*,
  *Reload theirs (discard mine)* and *Copy mine to clipboard*, with a line diff.
  If you have no unsaved edits the editor simply reloads. A change on disk
  that equals your text (for example the same edit saved elsewhere) is adopted
  silently, and the viewer's own saves never show up as outside changes. If the
  file is deleted while the editor has no unsaved edits, a banner says so but
  nothing counts as unsaved.
- **Images:** pasting or dropping an image into a markdown editor uploads it to
  an `assets/` folder next to the document (created if missing) as
  `image-YYYYMMDD-HHMMSS.png` and inserts `![](assets/...)` as its own
  paragraph: after the paragraph the cursor is in (lines are never split), or
  on the blank line the cursor is on.
- **File management:** right-click a tree row (files and folders) or use the
  `...` menu in the header: New file, New folder, Upload files, Rename, Move
  to..., Duplicate, Copy path, Version history, Delete. Drag a tree row onto a
  folder to move it (with a confirm). Drop files from your computer onto a
  folder in the tree, or onto the open page (uploads to its folder). Names are
  checked as you type against the same rules the server enforces.
- **Renames and moves do not rewrite links** inside other documents; the
  rename and move dialogs say so. The open file is followed to its new path.
- **Undo** in the toasts: delete restores from Trash, move/rename moves back,
  save offers *Restore previous version*.
- **Version history** (sheet): earlier versions with time, size and reason,
  content preview, diff against the current text, and Restore (the current
  version is saved to history first). Restoring a version identical to the
  current file changes nothing and says so; with unsaved edits open the
  confirm warns that they will conflict with the restored version.
  Focus returns to the control that opened a dialog or sheet when it closes.
- **Trash and activity** (sidebar footer): restore, restore to another path,
  delete permanently, empty trash; the Activity tab lists recent operations
  from the audit log with *Move back* for moves.

## Recovery data (the data dir)

Everything is stored under the data dir, never inside the docs root. It is not
served by any read endpoint and not indexed for search. Each docs root gets its
own store, so two roots sharing one data dir never see or restore each other's
history or trash (the path is printed at startup with `EDITING ENABLED`):

```
.data/state.json                   {last_root, recent}: the remembered folders (see Choosing and switching folders)
.data/roots/<key>/                 <key> = first 24 hex chars of sha256(canonical root path)
  root.json                        {root}; the server refuses to start if it names a different root
  audit.jsonl                      one JSON line per change: ts, op, path, to, size, sha256, history_id, trash_id (never contents)
  history/<sha256 of path>/<id>    previous bytes of a file, plus <id>.json {id, path, saved_at, size, sha256, reason}
  trash/<id>/                      a deleted file or folder, plus trash/<id>/manifest.json {id, original_path, deleted_at, kind, size, file_count}
```

Older builds wrote `history/`, `trash/` and `audit.jsonl` directly under the
data dir; those are not migrated (move them into the root's folder by hand if
you need them).

- A history version is written **before every overwrite**: save, upload with
  overwrite, move over an existing file, and history restore. The newest
  `--history-keep` (default 50) versions per file are kept. History follows
  moves and renames (including folder moves).
- **Delete** moves the file or the whole folder into `trash/` (a rename on the
  same file system, otherwise copy + fsync + remove). Restore puts it back at
  its original path (refused with 409 if something is there, unless you pick
  *Restore to...*). Items stay until you delete them permanently or empty the
  Trash.

## Backing up and clearing the data dir

The data dir is plain files; stop the server (or at least do not edit) while
copying it.

```sh
cd local-docs-viewer
# back up
tar czf ~/ldv-data-$(date +%Y%m%d).tgz .data
# free space: empty the Trash in the UI, or remove only the history
rm -rf .data/roots/*/history
# clear everything (history, trash, audit log and the remembered folders are gone for good)
rm -rf .data
```

The server recreates the folders on the next edit.

## Limits

- Text edits up to 2 MB per file (the editor refuses larger saves).
- Uploads: `--upload-max-mb` per file (default 25 MB, enforced while
  streaming, nothing is written above the limit), at most 20 files per
  request, extensions from `--upload-ext` only. Uploaded names are cleaned
  (directories stripped, Unicode normalised, unsafe characters replaced);
  a name that already exists gets `-1`, `-2`, ... unless overwrite is chosen
  (the old file then goes to history).
- Names are refused if they are empty, `.`/`..`, contain `/`, `\`, NUL,
  control or bidi characters, are longer than 255 bytes, start with a space or
  end with a space or dot, or match the deny or ignore list (so you cannot
  create `.env`, `x_token.md` or `__pycache__`). Existing names are compared
  ignoring case and Unicode normalisation, as APFS does.
- Folders that contain deny-listed files cannot be moved or deleted from the
  viewer (you could not see what would be affected).
- Symlinks are never written through or operated on.

## How writes are protected

When editing is on the server generates a random token at every launch
(`secrets.token_urlsafe(32)`). The UI reads it from `GET /api/config` (sent
with `Cache-Control: no-store`, and left out for cross-site requests). Every
`/api/edit/*` request, including the GET reads of history, trash and audit,
must:

- carry `X-Edit-Token` equal to the token (constant-time compare);
- pass the existing Host allowlist (`127.0.0.1` / `localhost`, else 400);
- have `Sec-Fetch-Site: same-origin` or no such header, and no `Origin` or
  exactly `http://127.0.0.1:<port>` / `http://localhost:<port>` (or port 3000
  for the dev server);
- use `Content-Type: application/json` (or `multipart/form-data` for upload
  only). A cross-site "simple" request such as a `text/plain` form post is
  therefore refused.

Anything else gets 403. Non-GET methods on every other route still get 405, and
the CSP is unchanged. Each write then goes through one guard: every path
component (including the new name) is checked against the root, the deny and
ignore lists and the name rules; no component may be a symlink (checked with
lstat), and the operation itself works through file descriptors of the
parent folders opened with `O_NOFOLLOW`, so a folder swapped for a symlink
after the check is refused (403) instead of followed; files are written
atomically (a `.ldv-tmp-*` file created with `O_EXCL` in the same folder,
fsync, original mode kept, renamed into place, temp file removed on any
error); creates, copies, moves and Trash restores use a no-replace rename (unless
overwrite was chosen), so they
never clobber a file that appeared in the meantime (409); and
a single process-wide lock serialises all changes. The tree, the search index
and the live-update stream are updated immediately, so each change is reported
once (moves as renames). The server refuses to start with `--allow-edit` if
the data dir is inside the root or the root is inside the data dir. Paths are
compared after resolving the real on-disk spelling, ignoring case and Unicode
normalisation, and by file identity, so `.../LOCAL_DEV/.data` or an NFD
spelling cannot slip past. In read-only mode a data dir inside the root is
hidden from the tree, search and every read endpoint under any spelling.
