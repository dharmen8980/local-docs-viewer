"use client";

import { useEffect, type RefObject } from "react";
import { stickyScroll } from "@/lib/sticky-scroll";

const HL_NAME = "search-hl";

export function queryTerms(q: string): string[] {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/^["'*]+|["'*]+$/g, "").toLowerCase())
    .filter((t) => t.length > 0);
  return Array.from(new Set(terms)).sort((a, b) => b.length - a.length);
}

function collectRanges(root: HTMLElement, terms: string[]): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || p.closest("style,script,.no-hl")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const tryTerms = (list: string[]) => {
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue ?? "").toLowerCase();
      if (!text) continue;
      for (const t of list) {
        let i = text.indexOf(t);
        while (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + t.length);
          ranges.push(r);
          i = text.indexOf(t, i + t.length);
        }
      }
      if (ranges.length > 2000) break;
    }
  };
  tryTerms(terms);
  if (ranges.length === 0) {
    // Fall back to alphanumeric sub-tokens, mirroring the server's line matcher.
    const sub = Array.from(new Set(terms.flatMap((t) => t.split(/[^\p{L}\p{N}]+/u)).filter((t) => t.length > 1)));
    if (sub.length) {
      walker.currentNode = root;
      tryTerms(sub);
    }
  }
  return ranges;
}

const BLOCK_SEL = "p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,dt,dd,figcaption,g.node,g.edgeLabel,.line,div";

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
}

/**
 * Pick the range to scroll to: the one whose enclosing block contains the most
 * distinct query terms (whole phrase first), then the best overlap with the
 * chosen search-match line text (`hint`), then document order.
 */
function bestRange(ranges: Range[], terms: string[], hint: string): Range | null {
  if (!ranges.length) return null;
  const phrase = terms.length > 1 ? terms.join(" ") : "";
  const hintWords = Array.from(new Set(words(hint)));
  const seen = new Map<Element, number>();
  let best: Range | null = null;
  let bestScore = -1;
  for (const r of ranges) {
    const node = r.startContainer;
    const el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(BLOCK_SEL);
    if (!el) continue;
    let score = seen.get(el);
    if (score === undefined) {
      const text = (el.textContent ?? "").toLowerCase();
      const distinct = terms.filter((t) => text.includes(t)).length;
      let overlap = 0;
      if (hintWords.length) {
        const have = new Set(words(text));
        overlap = hintWords.filter((w) => have.has(w)).length / hintWords.length;
      }
      score = (phrase && text.includes(phrase) ? 1000 : 0) + distinct * 10 + overlap * 9;
      seen.set(el, score);
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best ?? ranges[0];
}

/**
 * Highlight occurrences of `query` inside `ref` using the CSS Custom Highlight
 * API (no DOM mutation, so React-owned nodes are untouched) and scroll to the
 * best occurrence (see bestRange), keeping it in view while diagrams/images
 * finish rendering. Re-applies when the content changes.
 */
export function useHighlight(
  ref: RefObject<HTMLElement | null>,
  query: string,
  contentKey: unknown,
  hint = "",
) {
  useEffect(() => {
    const root = ref.current;
    const highlights = typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined;
    if (!root || !query.trim()) {
      highlights?.delete(HL_NAME);
      return;
    }
    const terms = queryTerms(query);
    if (!terms.length) return;
    let target: Range | null = null;
    let stopScroll: (() => void) | null = null;
    let userMoved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const apply = () => {
      const ranges = collectRanges(root, terms);
      if (highlights && typeof Highlight !== "undefined") {
        highlights.set(HL_NAME, new Highlight(...ranges));
      }
      if (userMoved) return;
      target = bestRange(ranges, terms, hint);
      if (target && !stopScroll) {
        stopScroll = stickyScroll(root, () => target?.getBoundingClientRect() ?? null, {
          offset: (h) => h / 3,
          onDone: () => {
            userMoved = true;
          },
        });
      }
    };
    apply();
    const obs = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(apply, 120);
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      if (timer) clearTimeout(timer);
      stopScroll?.();
      highlights?.delete(HL_NAME);
    };
  }, [ref, query, contentKey, hint]);
}
