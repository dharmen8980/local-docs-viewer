# Security model

- **Loopback only.** Uvicorn binds `127.0.0.1` and there is no host option.
  `TrustedHostMiddleware` accepts only `Host: 127.0.0.1` or `localhost`, which
  blocks DNS rebinding. There is no CORS.
- **Read-only by default.** Only GET and HEAD routes exist; anything else
  returns 405 (except the token-guarded `POST /api/roots/*`, see [The
  /api/roots endpoints](configuration.md#the-apiroots-endpoints-and-their-security-model),
  and `POST /api/seen/*`, see [below](#the-apiseen-endpoints)). Without `--allow-edit` the server never writes inside the root,
  and `/api/edit/*` returns 403. With it, writes are limited to `/api/edit/*`
  and protected as described in [How writes are protected](editing.md#how-writes-are-protected).
  The search index lives in an in-memory SQLite database. The git views run
  only read-only git commands, locked down as described [below](#git).
- **One path check for every endpoint** (`PathGuard.resolve`). It rejects empty
  paths, absolute paths and NUL bytes. It joins the path to the root, applies
  realpath, and requires the result to stay inside the root. It then applies the
  deny and ignore lists to both the requested and the resolved components.
  Outside the root or denied gives 403, missing gives 404. Denied files are
  never listed, served or indexed.
- **Symlinks.** Symlinked folders are never descended into. A symlinked file is
  shown only if its target is inside the root and passes the deny list. The
  `runtime_workdir/` links that point into the repo (including `.env`) are
  therefore hidden and refused.
- **Headers on every response:**
  - A strict `Content-Security-Policy`: `default-src 'self'`, no external
    hosts, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
    `wasm-unsafe-eval` is not needed, because shiki uses its JavaScript regex
    engine.
  - `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
- **`/api/raw`.** Only images and PDFs are served inline. SVGs get
  `Content-Security-Policy: sandbox; default-src 'none'; ...`. Everything else
  is sent as an `application/octet-stream` attachment.
- **Markdown.**
  - Rendered through `rehype-sanitize` (default schema).
  - External images are never loaded; a placeholder is shown instead.
  - External links open only on click, in a new tab with `rel=noreferrer`.
  - Mermaid runs with `securityLevel: 'strict'`. External `img:` URLs in
    mermaid nodes (and `<img src>` in labels) are replaced with a local
    placeholder before rendering, and the diagram shows "N external images
    blocked". Nothing is fetched from a CDN, even in `next dev`.
- **PDF export network lockdown.** Headless Chrome runs with a temporary
  profile in the system temp dir (deleted when the browser closes) and with
  background networking, component updates, sync, default apps, domain
  reliability, crash reporting/metrics, extensions and the first-run flow
  disabled. `--host-resolver-rules` makes every host except 127.0.0.1
  unresolvable, service workers are blocked, and a `route('**/*')` handler
  aborts every HTTP(S) request whose origin is not exactly
  `http://127.0.0.1:<port>` (blocked URLs are logged). Playwright's `route`
  does not see WebSockets, so a `route_web_socket('**/*')` handler closes every
  WebSocket as well (the viewer has none). The print page itself keeps the same
  strict CSP (`connect-src 'self'`) and never loads external images
  (placeholders, as in the viewer).
- **No telemetry, no external calls.** No Google fonts (system font stack), no
  CDN, and Next telemetry is disabled. FastAPI's OpenTelemetry hooks are
  switched off.

## The /api/seen endpoints

The history of [Changed since you last looked](changes.md) is stored by the
server in `<data dir>/seen.sqlite3` (mode 0600, data dir 0700 when the server
creates it), namespaced by the canonical root path. The endpoints are served
by the same outer app as `/api/roots` and only ever act on the folder being
shown. The What's new feed adds no endpoint: it reads snapshots and
`/api/content` and marks files with `/api/seen/mark`, like the banner and the
filter menu.

| Request | Result |
|---|---|
| `GET /api/seen?root=` | `{"records": [{root, path, mtime, size, viewedAt}]}`: every seen record of the folder |
| `GET /api/seen/snapshot?root=&path=` | `{"snapshot": {path, mtime, size, viewedAt, text} \| null}` |
| `POST /api/seen/get` `{root, paths}` | `{"records": [...]}` for those paths |
| `POST /api/seen/commit` `{root, path, mtime, size, text?, textSha256?}` | records the file as viewed now; `text` a string stores the snapshot, `null` drops it, absent leaves it; `textSha256` without `text` (a page unload over the 64 KB keepalive cap): the server reads the file and stores its text only if its SHA-256 matches, else drops the snapshot; `{"record"}` |
| `POST /api/seen/mark` `{root, entries: [{path, mtime, size}]}` | seen records only (snapshots kept); `{"records"}` |
| `POST /api/seen/rename` `{root, from, to}` | moves the records of `from` and everything below `from/`; `{"moved"}` |
| `POST /api/seen/clear` `{root}` | deletes every seen record and snapshot of the folder (**Clear history…**); `{"cleared": n}` |

- **Same gate as `/api/roots`.** Every `POST` needs the per-launch
  `X-Root-Token` (`root_token` in `/api/config`, same-site requests only),
  `Sec-Fetch-Site: same-origin` or none, no `Origin` or a loopback
  viewer/dev-server origin, and `Content-Type: application/json`; anything else
  gets 403, other methods 405. The body limit is 16 MB (a 2 MB snapshot,
  JSON-escaped). `--lock-root` does not affect these endpoints, by design: the
  history lives in the data dir and never changes which folder is shown.
- **Current folder only.** Every request names the root it was made for; any
  other value (a tab left open across a folder switch) gets 409, so nothing is
  written into another folder's history. With no folder selected: 409.
- **Path checks.** Stored paths may no longer exist (deleted or renamed
  files), so every path is checked lexically: relative, normalised (no `..`,
  `.`, empty components, backslashes or NUL), and no component may match the
  deny or ignore lists (403). Records whose names are denied later are not
  returned. `commit` also requires a regular, visible file
  (`PathGuard.resolve_file`), and `mark` only records files present in the
  tree. The files are never written by these endpoints. The only read is a
  `commit` with `textSha256`: the file already resolved by `resolve_file` is
  read up to the `/api/content` limit (2 MB; bigger files are not read and get
  no snapshot), decoded like `/api/content`, and stored only if its SHA-256
  equals the given one, so the request learns nothing it could not read with
  `/api/content`.
- **Never inside the folder.** If the data dir overlaps the root (inside it, or
  the root inside the data dir), the history is off for that folder:
  `/api/config` reports `"seen_enabled": false` and every `/api/seen*` request
  gets 403. If the database cannot be opened, `seen_enabled` is false and the
  requests get 503.
- Writes are announced on the live-update stream as a `seen` event
  (`{"paths", "client"}`, no file contents) to every tab of the same folder;
  `clear` sends `{"paths": [], "client", "cleared": true}`.

## Git

The [git views](git.md) run git on a repository the viewer did not create and
must treat as untrusted: its `.git/config` (and the files it includes) can name
programs that git runs on its own. Each of these is switched off, and only
subcommands that read are used.

- **How git is run.** `subprocess` with an argument list (never a shell), cwd
  at the work tree, stdin closed, its own process group (a timeout kills
  everything it started: 10 s per call, 20 s for `status` and `diff-index`),
  at most 4 git processes per folder and a cap on the output read (32 MB;
  more gives 413). The executable is resolved once (see
  [Which git](git.md#which-git)); the macOS `/usr/bin/git` stub is never run.
- **Environment.** Built from scratch, nothing inherited but `HOME`: a fixed
  `PATH` (`/usr/bin:/bin` plus git's own folder), `LC_ALL=C`,
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` (no system or user
  config; git 2.32+, the minimum used), `GIT_ATTR_NOSYSTEM=1`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` (`status` never refreshes or
  writes the index), `GIT_NO_LAZY_FETCH=1` (git 2.45+, see below),
  `GIT_LITERAL_PATHSPECS=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_ADVICE=0` (git
  2.46+, cosmetic only), `GIT_ATTR_SOURCE=<empty tree>` (git 2.40+, see
  Filters), pager, editor, ssh and askpass set to `cat` / `false`. Variables an
  older git does not know are simply ignored by it. No `GIT_DIR`,
  `GIT_WORK_TREE` or other `GIT_*` from the server's environment reaches git.
- **Command-line config beats the repository's.** Every call passes
  `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (command-line
  scope, which overrides every config file; git 2.31+) with:
  - `core.fsmonitor=false` (`status`, `diff-index` and `blame` would run a
    hook command named there), `core.useBuiltinFSMonitor=false`,
    `core.untrackedCache=false`;
  - `core.hooksPath=/dev/null` (none of the commands used runs hooks, this is
    a second line);
  - `core.pager=cat` plus `--no-pager`;
  - `core.sshCommand=false`, `core.askPass=`, `credential.helper=`,
    `protocol.allow=never` and `protocol.<name>.allow=never` for `file`, `git`,
    `ssh`, `http`, `https` and `ext` (a per-protocol key beats
    `protocol.allow`, so each is set);
  - `core.attributesFile=/dev/null` (repository config could point it at a
    file that assigns filters);
  - `safe.bareRepository=explicit` (a bare repository checked into the folder
    is never picked up), `submodule.recurse=false`,
    `diff.ignoreSubmodules=all`, `status.submoduleSummary=false` (status would
    otherwise run git inside each submodule, with that submodule's config);
  - `log.showSignature=false` (no gpg), `blame.ignoreRevsFile=`, `gc.auto=0`,
    `maintenance.auto=false`.
- **Partial clones and lazy fetches.** In a partial clone (a promisor
  remote: `extensions.partialClone` or `remote.<name>.promisor`) git fetches a
  missing object on demand, from `cat-file`, `blame`, `diff-index` or a
  rename-detecting `status`. A fetch runs the transport the repository names,
  and the repository can enable one that runs a program
  (`protocol.ext.allow=always` with an `ext::<command>` URL,
  `remote.<name>.uploadpack` over `file`, `core.gitProxy` over `git://`).
  `GIT_NO_LAZY_FETCH=1` is what stops lazy fetches, and git honours it only
  from 2.45. The transport settings are the second line: the
  `protocol.*.allow=never` list above, plus `protocol.<name>.allow=never` for
  every other protocol the repository's config names, and
  `remote.<name>.promisor=false` and `remote.<name>.uploadpack=false` for every
  remote it configures (`core.gitProxy` uses the first value found, so it
  cannot be overridden this way; `protocol.git.allow=never` blocks it). With
  git older than 2.45, a repository whose config has any promisor setting is
  refused (503) instead of relying on the second line alone.
- **Filters.** `clean`, `smudge` and `process` filters run when git reads a
  work tree file to compare it (`status` on a racy entry, `diff-index`,
  `blame`). Two layers keep them off. With git 2.40+ attributes are read from
  the empty tree (`GIT_ATTR_SOURCE`), so the work tree's `.gitattributes`
  cannot assign a `filter=` or `diff=` driver at all (only
  `.git/info/attributes` still applies). And before each call the viewer lists
  the repository's config keys (`git config --list --name-only`, which runs
  nothing) and, for every `filter.<driver>.*` it finds, adds
  `filter.<driver>.clean=`, `.smudge=`, `.process=` (empty: no filter) and
  `.required=false`. A driver that is not in any config file is not a program.
  Residual risk: the listing and the real call are two processes. A driver
  added to `.git/config` (or a file it includes) in between, and assigned by
  `.git/info/attributes` (or, on git before 2.40, by `.gitattributes`), is not
  blanked; the same applies to a promisor remote added in between on git
  before 2.45. This needs something writing into the repository's `.git`
  while you browse it.
- **Diff drivers.** `diff-index` gets `--no-ext-diff --no-textconv` (so
  `diff.external`, `diff.<driver>.command` and `textconv` are never run, and
  only `--numstat` counts are read), `blame` gets `--no-textconv`. The last
  commit's text is read with `ls-tree` and `cat-file blob <oid>`, which apply
  no filters or textconv (no `--filters` / `--textconv`).
- **The commands used.** `--version`, `rev-parse`, `symbolic-ref`,
  `config --list`, `status --porcelain=v2 -z --untracked-files=all
  --ignore-submodules=all`, `diff-index --numstat HEAD`, `ls-tree`,
  `cat-file blob` and `blame --porcelain -L`. Nothing that writes refs, the
  index, objects or the work tree (no checkout, so no smudge filters on
  checkout), and nothing that contacts a remote.
- **Paths.** Requested paths go through `PathGuard.resolve_file` (a file
  deleted since the last commit: the lexical check of the
  [seen history](#the-apiseen-endpoints)). Every path git reports is mapped
  back to the folder (outside it when the folder is a subfolder of the
  repository: dropped) and checked against the deny and ignore lists; denied
  and ignored files are never listed, and their last committed versions are
  never served (403), not even as the old side of a rename (a file renamed
  from a denied name shows as added, compared with nothing). A file symlinked
  inside the folder is looked up by its target; a symlink in the last commit
  is reported as binary and its target is not shown. Contents are capped at
  the `/api/content` limit (2 MB).
- **Requests.** Only `GET` / `HEAD`, behind the same `Host` and forwarded-host
  checks as every other route, and refused (403) when `Sec-Fetch-Site` or
  `Origin` says another site sent them, as for `/api/pdf`, since each call
  starts git processes. Each folder's app has its own repository object, so a
  request only ever reaches the folder being shown.
- **Detection** runs `git rev-parse --is-inside-work-tree --show-toplevel
  --show-object-format` (the object format picks the empty tree) in the
  folder with the same environment and config. The work tree must contain the
  folder (a `core.worktree` pointing elsewhere turns git off), and a folder
  inside `.git` is refused.
