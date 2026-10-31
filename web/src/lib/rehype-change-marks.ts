import type { Element, Root, RootContent } from "hast";
import type { ChangeMarks } from "@/lib/diff";

const removedLabel = (count: number) => `${count} block${count === 1 ? "" : "s"} removed`;

/** Its own element: a label hung on the next block would be clipped by hr/pre/table overflow. */
function removedMarker(label: string, className: string): Element {
  return {
    type: "element",
    tagName: "div",
    properties: { className: [className], dataRemovedLabel: label, ariaHidden: "true" },
    children: [],
  };
}

/**
 * Marks top-level blocks that changed since the last view: `data-change`
 * ("added" | "modified") on the block, and a `div.md-removed` marker before the
 * block that follows a removal (`div.md-removed-end` after the last block).
 * Source lines come from the hast positions, which match the mdast blocks of
 * lib/diff.ts (same parser). Must run after rehype-sanitize, which would strip
 * the data attributes and the marker elements.
 */
export function rehypeChangeMarks(marks: ChangeMarks | null) {
  return () => (tree: Root) => {
    if (!marks) return;
    const out: RootContent[] = [];
    for (const node of tree.children) {
      if (node.type !== "element" || !node.position) {
        out.push(node);
        continue;
      }
      const s = node.position.start.line;
      const e = node.position.end.line;
      let kind: "added" | "modified" | null = null;
      for (const r of marks.ranges) {
        if (r.start > e) break;
        if (r.end < s) continue;
        if (r.kind === "modified" || !kind) kind = r.kind;
      }
      if (kind) node.properties.dataChange = kind;
      const removed = marks.removed.find((r) => r.beforeLine !== null && r.beforeLine >= s && r.beforeLine <= e);
      if (removed) out.push(removedMarker(removedLabel(removed.count), "md-removed"));
      out.push(node);
    }
    const atEnd = marks.removed.find((r) => r.beforeLine === null);
    if (atEnd) out.push(removedMarker(`${removedLabel(atEnd.count)} at the end`, "md-removed-end"));
    tree.children = out;
  };
}
