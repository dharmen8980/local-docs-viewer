# Known limits

- Live updates come from `watchfiles` plus a full stat rescan every 10 s, which
  catches events FSEvents coalesces or misses.
- Renames are inferred within one batch of changes, in two ways:
  - The same size, mtime and basename means a move, which includes folder
    renames.
  - A unique same-directory match on size and mtime means an in-place rename.
  - If a rename is split across two batches, it shows up as a delete plus an
    add. The UI then shows a "deleted or moved" notice.
- `/api/content` refuses files over 2 MB with 413; viewers fall back to the
  chunked text viewer. Code highlighting is limited to files under 300 KB.
- Chunks snap to line boundaries. With very long lines (one line in
  `runtime.log` is about 107 KB), a head or tail chunk can be much smaller than
  128 KB.
- Search offsets are computed from the decoded text, so they can be slightly off
  in files with invalid UTF-8. Files larger than the search limit are not
  content-indexed (their names are still searchable).
- CSV previews show the first 5000 rows, and xlsx the first 1000 rows per
  sheet, with values stringified.
- In dark mode each mermaid diagram is rendered twice (dark for the screen, a
  light copy that only `@media print` shows), so printing uses light colours.
- PDF export: diagrams wider than the page are scaled down to the page width.
  Very wide or very large diagrams inside a markdown document can print with
  tiny labels (2-3pt) in portrait; for diagram-heavy documents choose
  Landscape. Standalone `.mmd` files pick landscape automatically (*Auto*), but
  extremely wide ones (5:1 and more) are still limited by the page width. External images (including
  mermaid `img:` icons from a CDN) print as placeholders. Diagrams are not
  rasterised, so text in the PDF stays selectable.
- Changed since you last looked:
  - Files over 2 MB get a dot and a banner, but no highlights or diff, because
    neither the earlier copy nor the current text is available.
  - The history lives in the server's data dir (`seen.sqlite3`) and is shared
    by every browser on that server; a viewer started with another data dir
    starts fresh. It is off when the data dir overlaps the browsed folder.
  - Closing or reloading the tab sends the version on screen with a
    `keepalive` request, which browsers limit to 64 KB. A larger text is sent
    as its SHA-256 instead; if the file changed again before the server reads
    it, the version is recorded without a saved copy, and the next change to
    that file gets a size-only banner with no highlights or diff. If the tab
    closes in the moment before the hash is ready, or the page is not a secure
    context (no `crypto.subtle`), the larger version may still not be recorded.
  - Two viewer processes sharing one data dir share the history file, but a
    tab only hears about changes made through its own server.
  - Very large rewrites can hit the 1 s diff budget; the banner then reads "too
    many changes to compare quickly" and offers no diff.
  - The What's new summaries are computed in the browser like the banner's (a
    content fetch, a snapshot fetch and a diff per row on screen, three at a
    time), so scrolling quickly through hundreds of large changed files takes a
    moment to fill in. Each diff of a row gets 0.2 s instead of the banner's
    1 s, so a large rewrite can read "too many changes to compare quickly" in
    the list while its banner shows the full summary. A row whose fetch failed
    keeps its placeholder and is tried again every few seconds. **Undo** after marking files as seen restores which
    version counts as seen, but not the open file's banner.
- Git views:
  - Read-only, and only against the last commit (`HEAD`): no other commits,
    branches or history browsing, and staged and unstaged changes are not told
    apart (`M` covers both).
  - Commits, checkouts and stages change only `.git`, which the viewer does not
    watch: the Uncommitted list catches up on window focus or within 30 s.
  - Submodules are skipped. Files git ignores are not listed. Line counts of
    new and untracked files are only computed for the first 1,000 of them and
    for files up to 2 MB; the list stops at 5,000 files.
  - Blame and the last commit's text are limited to 2 MB, like
    `/api/content`. Blame loads 2,000 lines at a time and does not follow
    copies or moves between files (`-C`/`-M`).
  - Repository config such as filters and textconv drivers is ignored on
    purpose (see [Security model](security.md#git)), so a repository that
    relies on a clean filter (git-lfs, git-crypt, …) can show every such file
    as changed, or compare against the pointer or encrypted text.
  - Git detection runs once per folder; install git and restart the viewer (or
    switch folders) to turn the views on. Git older than 2.32 is not used,
    and partial clones need git 2.45 or newer.
  - `.gitattributes` in the work tree is not read (attributes come from the
    empty tree, git 2.40+), so `eol` / `text` settings there do not apply and
    a file normalised by them can show as changed. `.git/info/attributes` is
    still read.
  - Untracked files are listed one by one (`--untracked-files=all`) before the
    viewer's ignore list is applied, so a huge untracked tree that git does not
    ignore can make the Uncommitted list slow, time out (20 s) or exceed the
    32 MB output cap (413). Add it to `.gitignore` or `--ignore` it.
- Folders that contain only hidden symlinks still appear as empty folders.
- macOS and Linux only: the write path relies on POSIX `dir_fd`/`O_NOFOLLOW`
  file operations, so native Windows is not supported (WSL should work).
