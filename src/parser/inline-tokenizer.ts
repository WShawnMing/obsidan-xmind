import type { MindMapInlineToken, MindMapWikiLink } from "../types";

const WIKILINK_REGEX = /\[\[([^[\]]+?)\]\]/g;

export function tokenizeInlineText(text: string): {
  tokens: MindMapInlineToken[];
  links: MindMapWikiLink[];
  label: string;
} {
  const tokens: MindMapInlineToken[] = [];
  const links: MindMapWikiLink[] = [];
  let cursor = 0;

  for (const match of text.matchAll(WIKILINK_REGEX)) {
    const index = match.index ?? 0;
    const raw = match[0];

    if (index > cursor) {
      const plainText = text.slice(cursor, index);
      tokens.push({
        type: "text",
        raw: plainText,
        text: plainText,
      });
    }

    const link = parseWikilink(raw);
    tokens.push({
      type: "wikilink",
      ...link,
    });
    links.push(link);
    cursor = index + raw.length;
  }

  if (cursor < text.length) {
    const plainText = text.slice(cursor);
    tokens.push({
      type: "text",
      raw: plainText,
      text: plainText,
    });
  }

  if (tokens.length === 0) {
    tokens.push({
      type: "text",
      raw: text,
      text,
    });
  }

  return {
    tokens,
    links,
    label: tokens.map((token) => token.text).join(""),
  };
}

export function parseWikilink(raw: string): MindMapWikiLink {
  const inner = raw.slice(2, -2);
  const pipeIndex = inner.indexOf("|");
  const destination = pipeIndex === -1 ? inner : inner.slice(0, pipeIndex);
  const alias = pipeIndex === -1 ? undefined : inner.slice(pipeIndex + 1).trim() || undefined;
  const hashIndex = destination.indexOf("#");
  const target = (hashIndex === -1 ? destination : destination.slice(0, hashIndex)).trim();
  const subpath = hashIndex === -1 ? undefined : destination.slice(hashIndex + 1).trim() || undefined;
  const text = alias ?? (subpath ? `${target}#${subpath}` : target);

  return {
    raw,
    text,
    target,
    alias,
    subpath,
  };
}
