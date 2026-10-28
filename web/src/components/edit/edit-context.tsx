"use client";

import { createContext, useContext } from "react";
import type { AppConfig } from "@/lib/api";
import type { NameRules } from "@/lib/edit-api";

/** File-management actions; the context value is null when editing is disabled. */
export interface EditOps {
  config: AppConfig;
  rules: NameRules;
  newFile: (dir: string) => void;
  newFolder: (dir: string) => void;
  /** Upload `files` into `dir`, or open the file picker when no files are given. */
  upload: (dir: string, files?: File[]) => void;
  rename: (path: string, isDir: boolean) => void;
  moveTo: (path: string, isDir: boolean) => void;
  /** Drag-and-drop move (asks for confirmation). */
  dropMove: (from: string, toDir: string, isDir: boolean) => void;
  duplicate: (path: string) => void;
  copyPath: (path: string) => void;
  remove: (path: string, isDir: boolean) => void;
  openHistory: (path: string) => void;
  openTrash: () => void;
}

export const EditOpsContext = createContext<EditOps | null>(null);

export function useEditOps(): EditOps | null {
  return useContext(EditOpsContext);
}

/** MIME type used for dragging tree rows. */
export const DRAG_MIME = "application/x-ldv-path";

export interface DragPayload {
  path: string;
  isDir: boolean;
}

export function readDrag(dt: DataTransfer | null): DragPayload | null {
  if (!dt) return null;
  const raw = dt.getData(DRAG_MIME);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as DragPayload;
    return typeof v.path === "string" ? v : null;
  } catch {
    return null;
  }
}

export function hasDrag(dt: DataTransfer | null): "row" | "files" | null {
  if (!dt) return null;
  const types = Array.from(dt.types);
  if (types.includes(DRAG_MIME)) return "row";
  if (types.includes("Files")) return "files";
  return null;
}

/** Paths whose move we started ourselves (so the live "file was moved" toast is not shown twice). */
export const ownMoves = new Set<string>();
