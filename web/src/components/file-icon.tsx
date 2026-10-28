import {
  FileBracesIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileQuestionIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  ScrollTextIcon,
  WorkflowIcon,
  type LucideProps,
} from "lucide-react";
import type { FileKind } from "@/lib/api";

const ICONS: Record<FileKind, React.ComponentType<LucideProps>> = {
  markdown: FileTextIcon,
  mermaid: WorkflowIcon,
  image: FileImageIcon,
  pdf: FileTypeIcon,
  json: FileBracesIcon,
  csv: FileSpreadsheetIcon,
  xlsx: FileSpreadsheetIcon,
  code: FileCodeIcon,
  text: ScrollTextIcon,
  binary: FileQuestionIcon,
};

export function FileKindIcon({ kind, ...props }: { kind: FileKind } & LucideProps) {
  const Icon = ICONS[kind] ?? FileIcon;
  return <Icon {...props} />;
}
