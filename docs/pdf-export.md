# PDF export

The file header of a markdown or mermaid file has a **PDF** menu: *Download PDF*
(A4, orientation *Auto* by default), paper A4/Letter, orientation
Auto/Portrait/Landscape and an optional table of contents (the choice is
remembered in localStorage). *Auto* prints markdown in portrait and a
standalone `.mmd` diagram in whichever orientation shows it larger (wide
flowcharts and sequence diagrams go landscape); the response header
`X-PDF-Orientation` says which one was used. The browser fetches
`GET /api/pdf?path=&paper=a4|letter&orientation=auto|portrait|landscape&toc=0|1`
and saves the result through an object URL; errors appear as a toast. If a
diagram failed or an image was missing, the toast says so (the response carries
`X-PDF-Mermaid-Errors` / `X-PDF-Image-Errors`). The existing Print button
(browser print dialog) is still there.

How it works:

1. `/api/pdf` runs the same `PathGuard.resolve` as every other endpoint (403
   outside the root or denied, 404 missing), then accepts only the `markdown`
   and `mermaid` kinds (else 400) and files up to 2 MB (else 413).
2. The server drives the system Chrome (headless, through Playwright) to its own
   static page `http://127.0.0.1:<port>/print?p=<path>&paper=&orientation=&toc=`.
   That route of the static export (`web/src/app/print`) renders only the
   document, always in the light theme, with the same markdown/mermaid renderers
   as the viewer, plus a cover block (title = first h1 or file name, repo-relative
   path, modified date) and, if asked, a table of contents on its own page.
3. The page sets `window.__PDF_READY__ = true` once every mermaid diagram has
   rendered (or shows its error and source), every image has loaded or failed,
   code highlighting is done and fonts are ready; `window.__PDF_ERRORS__` has the
   counts. The server waits up to 45 s for it (then 504).
4. `page.pdf()` prints with the CSS page size, backgrounds, a small header (doc
   title) and a footer (`path`, `page X of Y`), PDF bookmarks from the headings
   and a tagged PDF. The bytes are returned from memory as an attachment
   (`<name>.pdf`); nothing is written to disk inside the root.

Pagination rules (`globals.css`, section "PDF print layout"):

- `@page` size and margins come from the query (A4 or Letter, either orientation).
- Images, mermaid figures, blockquotes, table rows and short code blocks have
  `break-inside: avoid`; headings `break-after: avoid`; orphans/widows 3.
- Images and diagrams are scaled (aspect ratio kept) to at most the page width
  and roughly the printable page height, so they are never cut across pages.
  A standalone `.mmd` diagram is sized to fit page 1 under a compact cover.
- A tall figure right after a heading (or a heading and a one-line lead-in) is
  shrunk by the height of that lead, so the heading prints on the same page as
  its figure instead of alone on an otherwise blank page.
- Code blocks over 40 lines may split between pages but never in the middle of
  a line; wide code shrinks its font (down to 5.5pt) to fit, and only lines that
  still do not fit wrap.
- Tables span the page width, wrap their cells and repeat the header row on
  each page.
- Links print as plain text; in-repo links show their target path, `#anchor`
  links become PDF-internal links.

Browser lifecycle: jobs are serialised (one Chrome at a time, behind a lock).
The browser is reused while idle for less than 60 s, then closed; it is also
closed on server shutdown. If Chrome is not found, `/api/pdf` returns 503 with
a message saying so; if `web/out` has no `print.html`, 503 asks you to run
`npm run build`. `HEAD /api/pdf` answers 405 (it would need a render).
Cross-site requests are refused with 403: when the browser sends
`Sec-Fetch-Site` it must be `same-origin` or `none`, and an `Origin` header must
be a loopback `http://` origin, so a web page cannot make the viewer launch
Chrome with e.g. `<img src="http://127.0.0.1:8765/api/pdf?...">`. Temporary
profiles left behind by a crashed or killed server (`ldv-chrome-*` in the temp
dir, older than 10 minutes and not locked by a live Chrome) are removed the next
time Chrome starts. In dev mode the PDF is still rendered from the built `web/out`
served by FastAPI, so rebuild after changing the print page.
