"use client";

import { lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useTheme } from "next-themes";
import type { Text } from "@codemirror/state";
import {
  AlertTriangleIcon,
  CheckIcon,
  ClipboardCopyIcon,
  Columns2Icon,
  EyeIcon,
  FileWarningIcon,
  HistoryIcon,
  Loader2Icon,
  PencilIcon,
  RotateCcwIcon,
  SaveIcon,
  SearchIcon,
  UploadIcon,
  WrapTextIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ViewerError } from "@/components/viewers/common";
import { ARTICLE_CLASS, MarkdownMarkup, markdownComponents } from "@/components/viewers/markdown-viewer";
import { MermaidDiagram } from "@/components/viewers/mermaid-viewer";
import { useRoute } from "@/hooks/use-route";
import { ApiError, errorMessage, type FileInfo } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { editApi, EDIT_MAX_BYTES, loadEditable, utf8Length, type EditableText } from "@/lib/edit-api";
import { editorLangFor } from "@/lib/editor-lang";
import { dirname } from "@/lib/paths";
import { cn } from "@/lib/utils";
import type { CodeEditorHandle } from "./code-editor";
import { DiffView } from "@/components/diff/diff-view";

const CodeEditor = lazy(() => import("./code-editor"));

export interface EditorPaneHandle {
  /** Save now; resolves true when the file on disk now has the editor's content. */
  save: () => Promise<boolean>;
  /** The live-updates stream reported a change to the open file. */
  externalChange: (kind: "modified" | "deleted" | "added") => void;
  getText: () => string | null;
}

type Mode = "editor" | "split" | "preview";

interface Base {
  sha256: string | null;
  text: string;
}

interface Conflict {
  theirs: EditableText | null;
  reason: "save" | "disk";
}

interface JsonProblem {
  message: string;
  line: number;
  col: number;
}

function jsonProblem(text: string): JsonProblem | null {
  if (!text.trim()) return { message: "The document is empty.", line: 1, col: 1 };
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    const message = (e as Error).message || "Invalid JSON";
    const lc = /line (\d+) column (\d+)/i.exec(message);
    if (lc) return { message, line: Number(lc[1]), col: Number(lc[2]) };
    const pos = /position (\d+)/i.exec(message);
    if (pos) {
      const p = Math.min(Number(pos[1]), text.length);
      const before = text.slice(0, p);
      const line = before.split("\n").length;
      const col = p - before.lastIndexOf("\n");
      return { message, line, col };
    }
    return { message, line: text.split("\n").length, col: 1 };
  }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(key);
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
}

function ToolButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export interface EditorPaneProps {
  path: string;
  file: FileInfo;
  onDirtyChange: (dirty: boolean) => void;
  /** Leave edit mode (the caller prompts when there are unsaved changes). */
  onExit: () => void;
  onOpenHistory: (path: string) => void;
  /** a file was saved (for the caller's own bookkeeping): what is on disk now */
  onSaved?: (path: string, saved: { mtime: number; size: number; text: string }) => void;
  handleRef?: Ref<EditorPaneHandle>;
}

export function EditorPane({ path, file, onDirtyChange, onExit, onOpenHistory, onSaved, handleRef }: EditorPaneProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const { navigate } = useRoute();
  const isMd = file.kind === "markdown";
  const isMmd = file.kind === "mermaid";
  const hasPreview = isMd || isMmd;
  const isJson = file.kind === "json";

  const [loaded, setLoaded] = useState<EditableText | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>(() =>
    hasPreview ? readPref("viewer.editMode", ["editor", "split", "preview"] as const, "split") : "editor",
  );
  const [wrap, setWrapState] = useState<boolean>(() => {
    const def = isMd || file.kind === "text" || isMmd ? "on" : "off";
    return readPref(`viewer.editWrap.${isMd || isMmd ? "doc" : "code"}`, ["on", "off"] as const, def) === "on";
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const [liveText, setLiveText] = useState<string>("");
  const [jsonDialog, setJsonDialog] = useState<JsonProblem | null>(null);
  const [uploading, setUploading] = useState(false);

  const editorRef = useRef<CodeEditorHandle>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<Base>({ sha256: null, text: "" });
  const cleanDocRef = useRef<Text | null>(null);
  const savingRef = useRef(false);
  /** the save in flight (a second Cmd-S waits for it, then saves again if still dirty) */
  const inflightRef = useRef<Promise<boolean> | null>(null);
  /** bumped whenever a save starts or ends: disk reads that overlap a save are stale */
  const saveGenRef = useRef(0);
  /** sha256 of every version this editor session wrote */
  const ownShasRef = useRef<Set<string>>(new Set());
  const checkDiskRef = useRef<(kind: "modified" | "deleted" | "added", recheck?: boolean) => Promise<void>>(async () => {});
  const doSaveRef = useRef<(skipJsonCheck?: boolean) => Promise<boolean>>(async () => false);
  const pendingCheckRef = useRef<"modified" | "deleted" | "added" | null>(null);
  const missingRef = useRef(false);
  const dirtyRef = useRef(false);
  const pathRef = useRef(path);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    pathRef.current = path;
    missingRef.current = missing;
  });

  const setMode = (m: Mode) => {
    setModeState(m);
    window.localStorage.setItem("viewer.editMode", m);
  };
  const setWrap = (w: boolean) => {
    setWrapState(w);
    window.localStorage.setItem(`viewer.editWrap.${isMd || isMmd ? "doc" : "code"}`, w ? "on" : "off");
  };

  // Load the exact bytes once per edit session (the path may later change through a rename).
  useEffect(() => {
    const ctrl = new AbortController();
    loadEditable(pathRef.current, ctrl.signal)
      .then((t) => {
        baseRef.current = { sha256: t.sha256, text: t.text };
        setLiveText(t.text);
        setLoaded(t);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setLoadError(errorMessage(e));
      });
    return () => ctrl.abort();
  }, []);

  const updateDirty = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const doc = ed.getDoc();
    // A deleted file alone does not make the editor dirty (the banner offers to recreate it).
    const d = !ed.isSame(doc, cleanDocRef.current);
    if (d !== dirtyRef.current) {
      dirtyRef.current = d;
      setDirty(d);
      onDirtyChange(d);
    }
  }, [onDirtyChange]);

  const markClean = useCallback(
    (doc: Text | null) => {
      cleanDocRef.current = doc;
      updateDirty();
    },
    [updateDirty],
  );

  const onDocChange = useCallback(() => {
    updateDirty();
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => {
      const t = editorRef.current?.getText();
      if (t !== undefined) setLiveText(t);
    }, 300);
  }, [updateDirty]);
  useEffect(
    () => () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
    },
    [],
  );

  const replaceWith = useCallback(
    (t: EditableText) => {
      const ed = editorRef.current;
      if (!ed) return;
      if (ed.getText() !== t.text) ed.setText(t.text);
      baseRef.current = { sha256: t.sha256, text: t.text };
      setMissing(false);
      missingRef.current = false;
      setConflict(null);
      setLiveText(t.text);
      markClean(ed.getDoc());
    },
    [markClean],
  );

  /** The disk now holds exactly the editor's text: adopt it as the new base, no conflict. */
  const adoptIfEqual = useCallback(
    (theirs: EditableText | null): boolean => {
      const ed = editorRef.current;
      if (!ed || !theirs || ed.getText() !== theirs.text) return false;
      baseRef.current = { sha256: theirs.sha256, text: theirs.text };
      setMissing(false);
      missingRef.current = false;
      setConflict(null);
      markClean(ed.getDoc());
      return true;
    },
    [markClean],
  );

  const checkDisk = useCallback(
    async (kind: "modified" | "deleted" | "added", recheck = false): Promise<void> => {
      if (savingRef.current) {
        pendingCheckRef.current = kind;
        return;
      }
      if (kind === "deleted") {
        setMissing(true);
        missingRef.current = true;
        updateDirty();
        return;
      }
      const gen = saveGenRef.current;
      let theirs: EditableText;
      try {
        theirs = await loadEditable(pathRef.current);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && gen === saveGenRef.current && !savingRef.current) {
          setMissing(true);
          missingRef.current = true;
          updateDirty();
        }
        return;
      }
      if (savingRef.current) {
        pendingCheckRef.current = kind;
        return;
      }
      if (gen !== saveGenRef.current) {
        // A save started and finished while this read was in flight: the result may be older
        // than our own save. Read again.
        void checkDiskRef.current(kind, recheck);
        return;
      }
      if (theirs.sha256 === baseRef.current.sha256) {
        if (missingRef.current) {
          setMissing(false);
          missingRef.current = false;
          updateDirty();
        }
        return; // our own save, or a touch without content change
      }
      if (adoptIfEqual(theirs)) return; // someone saved exactly what we have
      if (ownShasRef.current.has(theirs.sha256) && !recheck) {
        // Looks like a late answer about one of our own earlier saves: look once more.
        setTimeout(() => void checkDiskRef.current(kind, true), 250);
        return;
      }
      const ed = editorRef.current;
      const unsaved = ed ? !ed.isSame(ed.getDoc(), cleanDocRef.current) : false;
      if (!unsaved) {
        replaceWith(theirs);
        toast.info("Reloaded: the file changed on disk", { description: pathRef.current });
        return;
      }
      setConflict({ theirs, reason: "disk" });
    },
    [replaceWith, updateDirty, adoptIfEqual],
  );
  useEffect(() => {
    checkDiskRef.current = checkDisk;
  }, [checkDisk]);

  const doSave = useCallback(
    async (skipJsonCheck = false): Promise<boolean> => {
      const ed = editorRef.current;
      if (!ed) return false;
      if (savingRef.current) {
        // Cmd-S while a save is in flight: save again afterwards if there is still something new.
        const prev = inflightRef.current;
        if (!prev) return false;
        return prev.then((ok) => {
          const e2 = editorRef.current;
          if (!ok || !e2) return false;
          if (e2.isSame(e2.getDoc(), cleanDocRef.current) && !missingRef.current) return true;
          return doSaveRef.current(skipJsonCheck);
        });
      }
      const doc = ed.getDoc();
      if (!doc) return false;
      const content = ed.textOf(doc);
      if (isJson && !skipJsonCheck) {
        const p = jsonProblem(content);
        if (p) {
          setJsonDialog(p);
          return false;
        }
      }
      if (utf8Length(content) > EDIT_MAX_BYTES) {
        toast.error("Too large to save", { description: "The editor saves files up to 2 MB." });
        return false;
      }
      const target = pathRef.current;
      const creating = missingRef.current;
      savingRef.current = true;
      saveGenRef.current += 1;
      setSaving(true);
      let resolveInflight: (ok: boolean) => void = () => {};
      inflightRef.current = new Promise<boolean>((r) => (resolveInflight = r));
      let ok = false;
      try {
        const r = await editApi.saveFile({
          path: target,
          content,
          base_sha256: creating ? null : baseRef.current.sha256,
          ...(creating ? { create: true } : {}),
        });
        baseRef.current = { sha256: r.sha256, text: content };
        ownShasRef.current.add(r.sha256);
        setMissing(false);
        missingRef.current = false;
        setConflict(null);
        markClean(doc);
        onSaved?.(target, { mtime: r.mtime, size: r.size, text: content });
        const historyId = r.history_id;
        toast.success("Saved", {
          description: target,
          action: historyId
            ? {
                label: "Restore previous version",
                onClick: () => {
                  editApi
                    .restoreHistory(target, historyId)
                    .then(() => toast.success("Previous version restored", { description: target }))
                    .catch((e) => toast.error("Could not restore", { description: errorMessage(e) }));
                },
              }
            : undefined,
        });
        ok = true;
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const theirs = await loadEditable(target).catch(() => null);
          if (adoptIfEqual(theirs)) {
            // The file on disk already holds exactly the editor's text.
            ok = true;
            return true;
          }
          if (theirs && theirs.sha256 === baseRef.current.sha256 && !creating) {
            // Nothing changed after all (e.g. a racing touch): just report the error.
            toast.error("Could not save", { description: errorMessage(e) });
          } else {
            setConflict({ theirs, reason: "save" });
          }
          return false;
        }
        toast.error("Could not save", { description: errorMessage(e) });
        return false;
      } finally {
        savingRef.current = false;
        saveGenRef.current += 1;
        inflightRef.current = null;
        resolveInflight(ok);
        setSaving(false);
        const pending = pendingCheckRef.current;
        pendingCheckRef.current = null;
        if (pending) void checkDisk(pending);
      }
    },
    [isJson, markClean, onSaved, checkDisk, adoptIfEqual],
  );
  useEffect(() => {
    doSaveRef.current = doSave;
  }, [doSave]);

  useImperativeHandle(
    handleRef,
    () => ({
      save: () => doSave(false),
      externalChange: (kind) => void checkDisk(kind),
      getText: () => editorRef.current?.getText() ?? null,
    }),
    [doSave, checkDisk],
  );

  // Cmd/Ctrl-S anywhere while editing (CodeMirror handles it itself when focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave]);

  // Esc leaves the editor from anywhere (toolbar, body after a dialog closed), not only from
  // inside CodeMirror, which handles its own Esc (search panel first, then onEscape).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(".cm-editor")) return;
      if (t && (t.closest("input, textarea, select, [contenteditable='true']") || t.closest("[role=menu], [role=listbox]")))
        return;
      // capture phase: a dialog, menu or popover that is about to close on this Esc is still here
      if (
        document.querySelector(
          "[role=dialog]:not([data-state=closed]), [role=alertdialog]:not([data-state=closed]), [role=menu]:not([data-state=closed]), [data-radix-popper-content-wrapper]:not(:has([role=tooltip])):not(:has([data-state=closed])), .cm-search",
        )
      )
        return;
      e.preventDefault();
      onExit();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [onExit]);

  // ---------- conflict actions ----------

  const overwrite = async () => {
    if (!conflict) return;
    if (conflict.theirs) baseRef.current = { sha256: conflict.theirs.sha256, text: conflict.theirs.text };
    else {
      setMissing(true);
      missingRef.current = true;
    }
    setConflict(null);
    await doSave(true);
  };
  const reloadTheirs = async () => {
    const theirs = conflict?.theirs ?? (await loadEditable(pathRef.current).catch(() => null));
    if (!theirs) {
      toast.error("Could not load the version on disk");
      return;
    }
    replaceWith(theirs);
  };
  const copyMine = async () => {
    const t = editorRef.current?.getText() ?? "";
    if (await copyText(t)) toast.success("Your version is on the clipboard");
    else toast.error("Could not copy to clipboard");
  };

  // ---------- images pasted/dropped into markdown ----------

  const onFiles = useCallback(
    (files: File[], pos: number | null): boolean => {
      if (!isMd) {
        toast.info("Drop files on a folder in the tree to upload them.");
        return true;
      }
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!images.length) {
        toast.info("Only images can be pasted or dropped into the editor.", {
          description: "Drop other files on a folder in the tree to upload them.",
        });
        return true;
      }
      const docDir = dirname(pathRef.current);
      const assets = docDir ? `${docDir}/assets` : "assets";
      const when = stamp();
      const named = images.map((f, i) => {
        const ext = IMAGE_EXT[f.type] ?? (f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "png");
        const name = `image-${when}${images.length > 1 ? `-${i + 1}` : ""}.${ext}`;
        return new File([f], name, { type: f.type });
      });
      setUploading(true);
      (async () => {
        try {
          try {
            await editApi.mkdir(assets);
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 409)) throw e;
          }
          const r = await editApi.upload(assets, named);
          const prefix = docDir ? `${docDir}/` : "";
          const links = (r.paths ?? []).map((p) => {
            const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
            const target = /[\s()<>]/.test(rel) ? `<${rel}>` : rel;
            return `![](${target})`;
          });
          if (links.length) editorRef.current?.insertAt(pos, links.join("\n"), true);
          toast.success(`Uploaded ${links.length} image${links.length === 1 ? "" : "s"}`, {
            description: (r.paths ?? []).join(", "),
          });
        } catch (e) {
          toast.error("Image upload failed", { description: errorMessage(e) });
        } finally {
          setUploading(false);
        }
      })();
      return true;
    },
    [isMd],
  );

  // ---------- preview ----------

  const onScrollFraction = useCallback((f: number) => {
    const el = previewRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = f * max;
  }, []);

  const scrollPreviewTo = useCallback((id: string) => {
    const root = document.querySelector<HTMLElement>("[data-edit-preview]");
    const el =
      root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? root?.querySelector<HTMLElement>(`#user-content-${CSS.escape(id)}`);
    el?.scrollIntoView({ block: "start" });
  }, []);

  const components = useMemo(
    () => markdownComponents(path, { navigate, selectHeading: scrollPreviewTo, scrollToId: scrollPreviewTo }),
    [path, navigate, scrollPreviewTo],
  );

  const liveJson = useMemo(() => (isJson && loaded ? jsonProblem(liveText) : null), [isJson, loaded, liveText]);
  const lang = useMemo(() => editorLangFor(file.name, file.ext, file.kind), [file.name, file.ext, file.kind]);

  if (loadError) {
    return (
      <ViewerError title="Cannot edit this file" message={loadError}>
        <Button variant="outline" size="sm" className="mt-2" onClick={onExit}>
          Back to viewer
        </Button>
      </ViewerError>
    );
  }

  const showEditor = !hasPreview || mode !== "preview";
  const showPreview = hasPreview && mode !== "editor";

  return (
    <div className="flex h-[calc(100svh-var(--header-h))] min-h-0 flex-col" data-editor-pane>
      <div
        role="toolbar"
        aria-label="Editor"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1"
      >
        {hasPreview ? (
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={mode}
            onValueChange={(v) => v && setMode(v as Mode)}
            aria-label="Layout"
          >
            <ToggleGroupItem value="editor" aria-label="Editor only">
              <PencilIcon /> <span className="hidden sm:inline">Editor</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="split" aria-label="Editor and preview">
              <Columns2Icon /> <span className="hidden sm:inline">Split</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="preview" aria-label="Preview only">
              <EyeIcon /> <span className="hidden sm:inline">Preview</span>
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle size="sm" pressed={wrap} onPressedChange={setWrap} aria-label="Wrap long lines">
              <WrapTextIcon />
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Wrap long lines</TooltipContent>
        </Tooltip>
        <ToolButton
          label="Find and replace (⌘F)"
          onClick={() => {
            if (mode === "preview") setMode("split");
            requestAnimationFrame(() => editorRef.current?.openSearch());
          }}
        >
          <SearchIcon />
        </ToolButton>
        {isJson && loaded ? (
          liveJson ? (
            <button
              type="button"
              className="ml-1 inline-flex max-w-[40ch] items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs text-destructive hover:bg-destructive/10"
              onClick={() => editorRef.current?.gotoLine(liveJson.line, liveJson.col)}
              title={liveJson.message}
            >
              <AlertTriangleIcon className="size-3.5 shrink-0" /> JSON error at {liveJson.line}:{liveJson.col}
            </button>
          ) : (
            <span className="ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5 text-emerald-600" /> valid JSON
            </span>
          )
        ) : null}
        {uploading ? (
          <span className="ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
            <UploadIcon className="size-3.5" /> uploading...
          </span>
        ) : null}
        <div className="flex-1" />
        <span className="mr-1 hidden text-xs text-muted-foreground sm:inline" aria-live="polite">
          {saving ? "Saving..." : dirty ? "Unsaved changes" : loaded ? "All changes saved" : ""}
        </span>
        <ToolButton label="Version history" onClick={() => onOpenHistory(path)}>
          <HistoryIcon />
        </ToolButton>
        <Button size="sm" variant={dirty ? "default" : "outline"} onClick={() => void doSave(false)} disabled={!loaded || saving}>
          {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save
          <kbd className="ml-1 hidden font-mono text-[10px] opacity-70 md:inline">⌘S</kbd>
        </Button>
        <Button size="sm" variant="ghost" onClick={onExit}>
          Done
        </Button>
      </div>

      {missing ? (
        <Alert className="m-2 w-auto shrink-0">
          <FileWarningIcon />
          <AlertTitle>This file no longer exists on disk</AlertTitle>
          <AlertDescription>It was deleted or moved. Saving will create it again at {path}.</AlertDescription>
        </Alert>
      ) : null}

      {conflict ? (
        <Alert variant="destructive" className="m-2 w-auto shrink-0" role="alert">
          <AlertTriangleIcon />
          <AlertTitle>
            {conflict.reason === "save"
              ? "Not saved: the file was changed on disk since you opened it"
              : "The file was changed on disk while you were editing"}
          </AlertTitle>
          <AlertDescription className="w-full">
            <div className="mt-1 flex flex-wrap gap-2">
              <Button size="sm" variant="destructive" onClick={() => void overwrite()}>
                <SaveIcon /> Overwrite with mine
              </Button>
              <Button size="sm" variant="outline" onClick={() => void reloadTheirs()}>
                <RotateCcwIcon /> Reload theirs (discard mine)
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copyMine()}>
                <ClipboardCopyIcon /> Copy mine to clipboard
              </Button>
              {conflict.theirs ? (
                <Button size="sm" variant="ghost" onClick={() => setShowDiff((s) => !s)}>
                  {showDiff ? "Hide changes" : "Show changes"}
                </Button>
              ) : null}
            </div>
            {conflict.theirs && showDiff ? (
              <DiffView
                className="mt-2 w-full text-foreground"
                oldText={conflict.theirs.text}
                newText={liveText}
                oldLabel="on disk (theirs)"
                newLabel="editor (mine)"
              />
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className={cn("grid min-h-0 flex-1", showEditor && showPreview ? "grid-rows-2 md:grid-cols-2 md:grid-rows-1" : "grid-cols-1")}>
        <div className={cn("min-h-0 min-w-0", !showEditor && "hidden", showPreview && "border-b md:border-r md:border-b-0")}>
          {loaded ? (
            <Suspense fallback={<Skeleton className="m-4 h-40" />}>
              <CodeEditor
                handleRef={editorRef}
                initialText={loaded.text}
                crlf={loaded.crlf}
                lang={lang}
                dark={dark}
                wrap={wrap}
                label={`Editing ${path}`}
                onDocChange={onDocChange}
                onSave={() => void doSave(false)}
                onEscape={() => {
                  onExit();
                  return true;
                }}
                onFiles={onFiles}
                onScrollFraction={showPreview ? onScrollFraction : undefined}
                onReady={() => {
                  markClean(editorRef.current?.getDoc() ?? null);
                  editorRef.current?.focus();
                }}
              />
            </Suspense>
          ) : (
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
        </div>
        {showPreview ? (
          <div ref={previewRef} className="min-h-0 min-w-0 overflow-auto" aria-label="Preview" data-edit-preview>
            {isMd ? (
              <div className="px-4 py-6 md:px-8">
                <article className={cn(ARTICLE_CLASS, "mx-auto max-w-4xl")}>
                  <MarkdownMarkup text={liveText} components={components} />
                </article>
              </div>
            ) : (
              <div className="p-4">
                {liveText.trim() ? (
                  <MermaidDiagram source={liveText} variant="file" />
                ) : (
                  <p className="text-sm text-muted-foreground">Empty diagram.</p>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <AlertDialog open={!!jsonDialog} onOpenChange={(o) => !o && setJsonDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This is not valid JSON</AlertDialogTitle>
            <AlertDialogDescription>
              Line {jsonDialog?.line}, column {jsonDialog?.col}: {jsonDialog?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={() => {
                const p = jsonDialog;
                if (p) requestAnimationFrame(() => editorRef.current?.gotoLine(p.line, p.col));
              }}
            >
              Go to error
            </AlertDialogAction>
            <AlertDialogAction variant="destructive" onClick={() => void doSave(true)}>
              Save anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
