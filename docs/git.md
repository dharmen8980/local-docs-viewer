# Git

When the folder you browse is inside a git work tree and git is installed, the
viewer adds three read-only views: what changed since the last commit, the
uncommitted files of the folder, and blame. It never commits, stages, checks
out, stashes or fetches, and never writes to the repository or to `.git`.
Without git, outside a repository, or with `--git off`, none of this appears.

## Since last commit

- The header of an open file has a **Changes since the last commit** button
  (a small amber dot on it means git reports the file as changed). It shows
  the same banner as [Changed since you last looked](changes.md#the-banner),
  but against the version in the last commit (`HEAD`): `2 added · 1 edited`,
  `N changes, +A −R lines`, `no changes since the last commit`, …
- Markdown gets the same block highlights (green, amber, dashed red), other
  text files the summary. **Show changes** opens the same line diff, with the
  last commit's version on the left.
- When a file has changes since you last viewed it, the banner has a switch:
  **Since last viewed** / **Since last commit**. A file with no seen changes
  but uncommitted ones uses the header button.
- A file that is not in the last commit (new, untracked, or before the first
  commit) shows every line as new. A file deleted since the last commit opens
  from the Uncommitted list as a diff of its last committed text against
  nothing. If the last commit's version is binary, a symlink or over 2 MB,
  only "binary file, not compared" / "too large to compare" is shown.
- A renamed file is compared with its old path in the last commit.

## Uncommitted

**What's new** (the `w` key) has an **Uncommitted** tab next to **Changed
since viewed**. It lists every file of the folder with uncommitted changes, as
`git status` reports them (staged or not, untracked files included):

| Badge | Meaning |
|---|---|
| `M` | modified |
| `A` | added (staged, not in the last commit) |
| `D` | deleted |
| `R` | renamed (the detail names the old path) |
| `??` | untracked |
| `U` | merge conflict |

- Each row shows `+A −R lines` against the last commit (`new file, 12 lines`
  for new files, `binary file changed` for binary ones). Newest change first,
  deleted files last.
- Click a row to open the file in **Since last commit** mode.
- When the folder is a subfolder of the repository, only the files inside it
  are listed, with paths relative to the folder. A file renamed into the folder
  from outside it shows as added, with no link to its old path.
- Denied names (`.env`, `*secret*`, …) and ignored ones never appear, and
  neither do files git ignores (`.gitignore`). Submodules are skipped.
- The list refreshes after live changes in the folder, when the window gets
  focus, and every 30 s while it is visible (commits and checkouts only touch
  `.git`, which the viewer does not watch). It shows at most 5,000 files.
- When the changes history is off (see [Changes](changes.md#where-the-data-lives))
  but git is on, What's new shows only the Uncommitted list.

## Blame

The **Blame** button in the header of a text file (up to 2 MB, already
committed) shows, in place of the file, who last changed each line: the short
commit hash, the author and how long ago, once per run of lines from the same
commit. Hover for the full date and the commit summary. Lines that are not
committed yet are tinted and marked `uncommitted`. Large files load 2,000 lines
at a time (**Load more**). Close goes back to the plain view.

## Which git

The viewer looks for git (version 2.32 or newer) on `PATH` and then in
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `/bin`. The desktop app
launched from Finder has a minimal `PATH`, which these fallbacks cover.
Partial clones (`git clone --filter=...`) need git 2.45 or newer; with an older
git the views are refused for them (see
[Security model](security.md#git)).

- `--git /path/to/git` or `DOCS_VIEWER_GIT=/path/to/git` uses that executable
  (an absolute path; anything else turns git off with a warning).
- `--git off` or `DOCS_VIEWER_GIT=off` turns every git feature off.
- On macOS, `/usr/bin/git` is a stub that opens an "install the command line
  developer tools" dialog when they are missing. The viewer never runs it: it
  asks `xcode-select -p` for the developer folder and runs the git inside it,
  or treats git as missing.
- `/api/config` reports `"git_enabled"`; the UI hides every git control when it
  is false. Detection happens once per folder (on the first request after the
  folder is opened); restart the viewer or switch folders after installing git.
- Repositories owned by another user are refused by git itself
  (`safe.directory`) and the features stay off. User and system git config are
  not read at all, so `safe.directory` in your `~/.gitconfig` does not change
  that.

## Endpoints

All `GET` (and `HEAD`), current folder only, never writing. See
[Security model](security.md#git) for how git is run.

| Request | Result |
|---|---|
| `GET /api/git/status` | `{head, branch, prefix, truncated, files: [{path, status, origPath, added, removed, binary, kind, mtime, size}]}` |
| `GET /api/git/file?path=` | `{path, status, origPath, exists, headCommit, head: {oid, size, text, binary, tooLarge} \| null}`; `head` is null when the file is not in the last commit |
| `GET /api/git/blame?path=&start=&count=` | `{path, start, total, tracked, lines: [{line, origLine, commit, text}], commits: {oid: {short, author, authorTime, summary, uncommitted}}}`; `count` at most 5,000 |

Errors: 404 when git is off for the folder (or the file does not exist and
is not deleted since the last commit), 400 without a `path` or for a binary
file (blame), 403 for refused paths and
cross-site requests, 413 for a file over 2 MB (blame) or too much output, 504
when git takes too long, 502 when git fails.
