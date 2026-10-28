"use client";

// CodeMirror 6 wrapper. Loaded lazily (only when someone enters edit mode), so
// the read-only viewer bundle does not grow.

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import {
  closeSearchPanel,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
} from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Prec, Text, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { EditorLang } from "@/lib/editor-lang";

function langExtension(lang: EditorLang): Extension {
  switch (lang) {
    case "markdown":
      return markdown({ base: markdownLanguage });
    case "json":
      return json();
    case "python":
      return python();
    case "yaml":
      return yaml();
    case "shell":
      return StreamLanguage.define(shell);
    case "javascript":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "css":
      return css();
    case "html":
      return html();
    case "xml":
      return StreamLanguage.define(xml);
    case "toml":
      return StreamLanguage.define(toml);
    case "sql":
      return StreamLanguage.define(standardSQL);
    case "dockerfile":
      return StreamLanguage.define(dockerFile);
    case "go":
      return StreamLanguage.define(go);
    case "rust":
      return StreamLanguage.define(rust);
    case "diff":
      return StreamLanguage.define(diffMode);
    case "ini":
      return StreamLanguage.define(properties);
    default:
      return [];
  }
}

// ---------- themes (follow the app's CSS variables) ----------

function baseTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
        fontSize: "13px",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
      ".cm-content": { caretColor: "var(--foreground)", paddingBottom: "40vh" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
      ".cm-gutters": {
        backgroundColor: "var(--muted)",
        color: "var(--muted-foreground)",
        borderRight: "1px solid var(--border)",
      },
      ".cm-activeLineGutter": { backgroundColor: dark ? "oklch(1 0 0 / 8%)" : "oklch(0 0 0 / 6%)" },
      ".cm-activeLine": { backgroundColor: dark ? "oklch(1 0 0 / 4%)" : "oklch(0 0 0 / 3%)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: dark ? "oklch(0.55 0.12 250 / 45%)" : "oklch(0.75 0.1 250 / 40%)" },
      ".cm-searchMatch": { backgroundColor: dark ? "oklch(0.7 0.15 90 / 35%)" : "oklch(0.9 0.15 95 / 70%)" },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: dark ? "oklch(0.7 0.17 60 / 55%)" : "oklch(0.8 0.17 70 / 80%)",
      },
      ".cm-selectionMatch": { backgroundColor: dark ? "oklch(1 0 0 / 10%)" : "oklch(0 0 0 / 7%)" },
      ".cm-panels": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
      },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
      ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "12px" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "12px" },
      ".cm-textfield": {
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
        border: "1px solid var(--input)",
        borderRadius: "6px",
        padding: "2px 6px",
      },
      ".cm-button": {
        backgroundImage: "none",
        backgroundColor: "var(--secondary)",
        color: "var(--secondary-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
      },
      ".cm-foldPlaceholder": { backgroundColor: "var(--muted)", border: "1px solid var(--border)" },
    },
    { dark },
  );
}

const lightHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "#cf222e" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#0a3069" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#0550ae" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6e7781", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace], color: "#953800" },
  { tag: [t.propertyName, t.attributeName], color: "#0550ae" },
  { tag: [t.definition(t.variableName)], color: "#953800" },
  { tag: [t.tagName], color: "#116329" },
  { tag: t.heading, color: "#0550ae", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#0969da", textDecoration: "underline" },
  { tag: [t.monospace], color: "#953800" },
  { tag: [t.quote], color: "#57606a" },
  { tag: [t.meta, t.processingInstruction], color: "#6e7781" },
  { tag: t.inserted, color: "#116329" },
  { tag: t.deleted, color: "#82071e" },
  { tag: t.invalid, color: "#cf222e" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "#ff7b72" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a5d6ff" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#79c0ff" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#8b949e", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#d2a8ff" },
  { tag: [t.typeName, t.className, t.namespace], color: "#ffa657" },
  { tag: [t.propertyName, t.attributeName], color: "#79c0ff" },
  { tag: [t.definition(t.variableName)], color: "#ffa657" },
  { tag: [t.tagName], color: "#7ee787" },
  { tag: t.heading, color: "#79c0ff", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#58a6ff", textDecoration: "underline" },
  { tag: [t.monospace], color: "#ffa657" },
  { tag: [t.quote], color: "#8b949e" },
  { tag: [t.meta, t.processingInstruction], color: "#8b949e" },
  { tag: t.inserted, color: "#7ee787" },
  { tag: t.deleted, color: "#ffa198" },
  { tag: t.invalid, color: "#ff7b72" },
]);

function themeExtension(dark: boolean): Extension {
  return [baseTheme(dark), syntaxHighlighting(dark ? darkHighlight : lightHighlight)];
}

// ---------- component ----------

export interface CodeEditorHandle {
  /** document text, joined with the file's own line separator */
  getText: () => string;
  /** the current immutable document (cheap; compare with `isSame`) */
  getDoc: () => Text | null;
  /** text of a document captured earlier with getDoc() */
  textOf: (doc: Text) => string;
  isSame: (a: Text | null, b: Text | null) => boolean;
  /** Replace the whole document (keeps undo history unless `resetHistory`). */
  setText: (text: string) => void;
  /** true when the document equals `text` */
  equals: (text: string) => boolean;
  focus: () => void;
  openSearch: () => void;
  gotoLine: (line: number, col?: number) => void;
  /** insert at pos (or the cursor); `block` puts the text on its own line(s) */
  insertAt: (pos: number | null, text: string, block?: boolean) => void;
  cursor: () => number;
  /** 0..1 position of the top visible line */
  scrollFraction: () => number;
}

export interface CodeEditorProps {
  initialText: string;
  crlf: boolean;
  lang: EditorLang;
  dark: boolean;
  wrap: boolean;
  label: string;
  onDocChange?: () => void;
  onSave?: () => void;
  /** Escape outside the search panel; return true when handled */
  onEscape?: () => boolean;
  /** Pasted/dropped files; return true when handled */
  onFiles?: (files: File[], pos: number | null) => boolean;
  onScrollFraction?: (fraction: number) => void;
  /** the view exists and the handle is usable */
  onReady?: () => void;
  handleRef?: Ref<CodeEditorHandle>;
}

export default function CodeEditor({
  initialText,
  crlf,
  lang,
  dark,
  wrap,
  label,
  onDocChange,
  onSave,
  onEscape,
  onFiles,
  onScrollFraction,
  onReady,
  handleRef,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const comps = useRef({ lang: new Compartment(), theme: new Compartment(), wrap: new Compartment() });
  const cb = useRef({ onDocChange, onSave, onEscape, onFiles, onScrollFraction, onReady });
  useEffect(() => {
    cb.current = { onDocChange, onSave, onEscape, onFiles, onScrollFraction, onReady };
  });
  const initial = useRef({ initialText, crlf, lang, dark, wrap, label });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const init = initial.current;
    const c = comps.current;
    const fileList = (list: FileList | null | undefined): File[] => (list ? Array.from(list) : []);
    const state = EditorState.create({
      doc: init.initialText,
      extensions: [
        ...(init.crlf ? [EditorState.lineSeparator.of("\r\n")] : []),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: false }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        Prec.highest(
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                cb.current.onSave?.();
                return true;
              },
            },
            {
              key: "Escape",
              run: (view) => {
                if (searchPanelOpen(view.state)) {
                  closeSearchPanel(view);
                  return true;
                }
                return cb.current.onEscape?.() ?? false;
              },
            },
          ]),
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({ "aria-label": init.label }),
        c.lang.of(langExtension(init.lang)),
        c.theme.of(themeExtension(init.dark)),
        c.wrap.of(init.wrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onDocChange?.();
        }),
        EditorView.domEventHandlers({
          paste(e, view) {
            const files = fileList(e.clipboardData?.files);
            if (!files.length || !cb.current.onFiles) return false;
            if (cb.current.onFiles(files, view.state.selection.main.head)) {
              e.preventDefault();
              return true;
            }
            return false;
          },
          drop(e, view) {
            const files = fileList(e.dataTransfer?.files);
            if (!files.length) return false;
            e.preventDefault();
            e.stopPropagation();
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            cb.current.onFiles?.(files, pos);
            return true;
          },
          scroll(_e, view) {
            const s = view.scrollDOM;
            const max = s.scrollHeight - s.clientHeight;
            cb.current.onScrollFraction?.(max > 0 ? s.scrollTop / max : 0);
            return false;
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    cb.current.onReady?.();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: comps.current.lang.reconfigure(langExtension(lang)) });
  }, [lang]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: comps.current.theme.reconfigure(themeExtension(dark)) });
  }, [dark]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: comps.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useImperativeHandle(
    handleRef,
    (): CodeEditorHandle => ({
      getText: () => viewRef.current?.state.sliceDoc() ?? "",
      getDoc: () => viewRef.current?.state.doc ?? null,
      textOf: (doc) => doc.sliceString(0, doc.length, viewRef.current?.state.lineBreak ?? "\n"),
      isSame: (a, b) => (a && b ? a === b || a.eq(b) : a === b),
      setText: (text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      },
      equals: (text) => {
        const view = viewRef.current;
        if (!view) return true;
        const sep = view.state.lineBreak;
        return view.state.doc.eq(Text.of(text.split(sep === "\n" ? /\r\n?|\n/ : sep)));
      },
      focus: () => viewRef.current?.focus(),
      openSearch: () => {
        const view = viewRef.current;
        if (view) openSearchPanel(view);
      },
      gotoLine: (line, col = 1) => {
        const view = viewRef.current;
        if (!view) return;
        const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        const pos = Math.min(l.to, l.from + Math.max(0, col - 1));
        view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
        view.focus();
      },
      insertAt: (pos, raw, block = false) => {
        const view = viewRef.current;
        if (!view) return;
        let at = pos ?? view.state.selection.main.head;
        let text = raw;
        if (block) {
          // Put the text in its own paragraph: after the paragraph at the cursor (never splitting
          // a sentence or a hard-wrapped paragraph), or on the blank line the cursor is on.
          const doc = view.state.doc;
          let line = doc.lineAt(at);
          if (line.text.trim()) {
            while (line.number < doc.lines && doc.line(line.number + 1).text.trim()) line = doc.line(line.number + 1);
            at = line.to;
            text = `\n\n${raw}${line.number === doc.lines ? "\n" : ""}`;
          } else {
            at = line.from;
            const prevBlank = line.number === 1 || !doc.line(line.number - 1).text.trim();
            const nextBlank = line.number === doc.lines || !doc.line(line.number + 1).text.trim();
            text = `${prevBlank ? "" : "\n"}${raw}${nextBlank ? "" : "\n"}`;
          }
        }
        view.dispatch({
          changes: { from: at, insert: text },
          selection: EditorSelection.cursor(at + text.length),
          scrollIntoView: true,
        });
        view.focus();
      },
      cursor: () => viewRef.current?.state.selection.main.head ?? 0,
      scrollFraction: () => {
        const s = viewRef.current?.scrollDOM;
        if (!s) return 0;
        const max = s.scrollHeight - s.clientHeight;
        return max > 0 ? s.scrollTop / max : 0;
      },
    }),
    [],
  );

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full" />;
}
