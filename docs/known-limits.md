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
- Folders that contain only hidden symlinks still appear as empty folders.
- macOS and Linux only: the write path relies on POSIX `dir_fd`/`O_NOFOLLOW`
  file operations, so native Windows is not supported (WSL should work).
