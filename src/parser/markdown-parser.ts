import { tokenizeInlineText } from "./inline-tokenizer";
import type {
  MindMapImageEmbed,
  MindMapInlineToken,
  MindMapDocument,
  MindMapNode,
  NodeSourceSpan,
  SourceDocumentRef,
} from "../types";

const HEADING_REGEX = /^(#{1,6})([ \t]+)(.*?)([ \t]+#+[ \t]*)?$/;
const LIST_ITEM_REGEX = /^(\s*)([-+*]|\d+[.)])([ \t]+)(.*)$/;
const PURE_WIKILINK_LINE_REGEX = /^(?:\[\[[^[\]]+?\]\](?:\s+|$))+$/;
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"([^"]*)")?\)/g;

interface HeadingStackEntry {
  depth: number;
  node: MindMapNode;
}

interface ParsedHeadingLine {
  depth: number;
  text: string;
  span: NodeSourceSpan;
}

interface ParsedListLine {
  indent: number;
  text: string;
  span: NodeSourceSpan;
}

interface LineTable {
  lines: string[];
  offsets: number[];
}

export function parseMarkdownToMindMap(
  file: SourceDocumentRef,
  content: string,
): MindMapDocument {
  const nodesById = new Map<string, MindMapNode>();
  const warnings: string[] = [];
  const { lines, offsets } = buildLineTable(content);
  const roots: MindMapNode[] = [];
  const headingStack: HeadingStackEntry[] = [];
  const h1Nodes: MindMapNode[] = [];

  let pendingOverflowParent: MindMapNode | null = null;
  let fenceMarker: string | null = null;
  let fenceLength = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

    if (fenceMatch) {
      const fenceToken = fenceMatch[1] ?? "";
      const marker = fenceToken[0] ?? "";
      const markerLength = fenceToken.length;

      if (!fenceMarker) {
        fenceMarker = marker;
        fenceLength = markerLength;
      } else if (fenceMarker === marker && markerLength >= fenceLength) {
        fenceMarker = null;
        fenceLength = 0;
      }

      pendingOverflowParent = null;
      continue;
    }

    if (fenceMarker) {
      continue;
    }

    const absoluteOffset = offsets[lineIndex] ?? 0;
    const heading = parseHeadingLine(line, lineIndex, absoluteOffset);

    if (heading) {
      const node = createNode(
        file.path,
        heading.text,
        {
          kind: "heading",
          depth: heading.depth,
          span: heading.span,
        },
        nodesById,
      );

      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1]!.depth >= heading.depth
      ) {
        headingStack.pop();
      }

      const parent = headingStack[headingStack.length - 1]?.node;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }

      headingStack.push({
        depth: heading.depth,
        node,
      });

      if (heading.depth === 1) {
        h1Nodes.push(node);
      }

      pendingOverflowParent = heading.depth === 6 ? node : null;
      continue;
    }

    const currentHeadingNode = headingStack[headingStack.length - 1]?.node ?? null;
    if (currentHeadingNode) {
      const linkedNotes = parseLinkedNoteLine(
        file.path,
        line,
        lineIndex,
        absoluteOffset,
        currentHeadingNode.source.depth,
        nodesById,
      );

      if (linkedNotes.length > 0) {
        currentHeadingNode.children.push(...linkedNotes);
        continue;
      }

      const imageEmbeds = parseImageEmbedLine(
        file.path,
        line,
        lineIndex,
        absoluteOffset,
        currentHeadingNode.source.depth,
        nodesById,
      );
      if (imageEmbeds.length > 0) {
        currentHeadingNode.children.push(...imageEmbeds);
        continue;
      }
    }

    if (pendingOverflowParent) {
      if (line.trim().length === 0) {
        continue;
      }

      const listLine = parseOverflowListLine(line, lineIndex, absoluteOffset, 7);
      if (listLine) {
        const parsedOverflow = parseOverflowListBlock(
          file.path,
          lines,
          offsets,
          lineIndex,
          pendingOverflowParent,
          nodesById,
        );
        pendingOverflowParent.children.push(...parsedOverflow.nodes);
        lineIndex = parsedOverflow.nextIndex - 1;
        pendingOverflowParent = null;
        continue;
      }
      continue;
    }
  }

  const root = createRootNode(file, roots, h1Nodes, nodesById);

  return {
    root,
    nodesById,
    warnings,
  };
}

function createRootNode(
  file: SourceDocumentRef,
  roots: MindMapNode[],
  h1Nodes: MindMapNode[],
  nodesById: Map<string, MindMapNode>,
): MindMapNode {
  if (roots.length === 1 && h1Nodes.length === 1 && roots[0] === h1Nodes[0]) {
    return roots[0]!;
  }

  const root = createNode(
    file.path,
    file.basename,
    {
      kind: "virtual-root",
      depth: 0,
    },
    nodesById,
    `virtual-root:${file.path}`,
  );
  root.children.push(...roots);
  return root;
}

function createNode(
  filePath: string,
  text: string,
  source: MindMapNode["source"],
  nodesById: Map<string, MindMapNode>,
  explicitId?: string,
  overrides?: Partial<Pick<MindMapNode, "label" | "tokens" | "links" | "image">>,
): MindMapNode {
  const tokenized = tokenizeInlineText(text);
  const tokens = overrides?.tokens ?? tokenized.tokens;
  const links = overrides?.links ?? tokenized.links;
  const label = overrides?.label ?? tokenized.label;
  const id =
    explicitId ??
    `${source.kind}:${filePath}:${source.span?.line ?? 0}:${source.span?.from ?? 0}`;
  const node: MindMapNode = {
    id,
    text,
    label,
    tokens,
    links,
    image: overrides?.image,
    children: [],
    collapsed: false,
    source,
  };

  nodesById.set(id, node);
  return node;
}

function buildLineTable(content: string): LineTable {
  const lines = content.split("\n");
  const offsets: number[] = [];
  let offset = 0;

  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  return { lines, offsets };
}

function parseHeadingLine(
  line: string,
  lineIndex: number,
  absoluteOffset: number,
): ParsedHeadingLine | null {
  const match = line.match(HEADING_REGEX);
  if (!match) {
    return null;
  }

  const hashes = match[1] ?? "";
  const spacing = match[2] ?? "";
  const rawText = match[3] ?? "";
  const textStart = hashes.length + spacing.length;
  const textEnd = textStart + rawText.length;

  return {
    depth: hashes.length,
    text: rawText,
    span: {
      from: absoluteOffset + textStart,
      to: absoluteOffset + textEnd,
      line: lineIndex + 1,
      column: textStart,
      depth: hashes.length,
      kind: "heading",
    },
  };
}

function parseOverflowListBlock(
  filePath: string,
  lines: string[],
  offsets: number[],
  startIndex: number,
  parent: MindMapNode,
  nodesById: Map<string, MindMapNode>,
): {
  nodes: MindMapNode[];
  nextIndex: number;
} {
  const nodes: MindMapNode[] = [];
  const stack: Array<{ indent: number; depth: number; node: MindMapNode }> = [];
  let nextIndex = startIndex;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex] ?? "";
    const absoluteOffset = offsets[nextIndex] ?? 0;

    if (line.trim().length === 0) {
      nextIndex += 1;
      continue;
    }

    if (parseHeadingLine(line, nextIndex, absoluteOffset)) {
      break;
    }

    const parsed = parseOverflowListLine(
      line,
      nextIndex,
      absoluteOffset,
      stack.length > 0 ? stack[stack.length - 1]!.depth + 1 : 7,
    );

    if (parsed) {
      while (stack.length > 0 && parsed.indent <= stack[stack.length - 1]!.indent) {
        stack.pop();
      }

      const parentEntry = stack[stack.length - 1];
      const parentNode = parentEntry?.node ?? parent;
      const depth = parentEntry ? parentEntry.depth + 1 : 7;
      const node = createNode(
        filePath,
        parsed.text,
        {
          kind: "overflow-list",
          depth,
          span: {
            ...parsed.span,
            depth,
          },
        },
        nodesById,
      );

      if (parentEntry) {
        parentEntry.node.children.push(node);
      } else {
        nodes.push(node);
      }

      stack.push({
        indent: parsed.indent,
        depth,
        node,
      });
      nextIndex += 1;
      continue;
    }

    if (stack.length > 0) {
      const deepestEntry = stack[stack.length - 1]!;
      const currentIndent = getIndentWidth(line);
      if (currentIndent > deepestEntry.indent) {
        const linkedNotes = parseLinkedNoteLine(
          filePath,
          line,
          nextIndex,
          absoluteOffset,
          deepestEntry.depth,
          nodesById,
        );
        if (linkedNotes.length > 0) {
          deepestEntry.node.children.push(...linkedNotes);
          nextIndex += 1;
          continue;
        }

        const imageEmbeds = parseImageEmbedLine(
          filePath,
          line,
          nextIndex,
          absoluteOffset,
          deepestEntry.depth,
          nodesById,
        );
        if (imageEmbeds.length > 0) {
          deepestEntry.node.children.push(...imageEmbeds);
        }
        nextIndex += 1;
        continue;
      }
    }

    break;
  }

  return {
    nodes,
    nextIndex,
  };
}

function parseOverflowListLine(
  line: string,
  lineIndex: number,
  absoluteOffset: number,
  depth: number,
): ParsedListLine | null {
  const match = line.match(LIST_ITEM_REGEX);
  if (!match) {
    return null;
  }

  const indent = getIndentWidth(match[1] ?? "");
  const spacing = match[3] ?? "";
  const rawText = match[4] ?? "";

  if (/^\[[ xX]\][ \t]+/.test(rawText)) {
    return null;
  }

  const textStart = (match[1] ?? "").length + (match[2] ?? "").length + spacing.length;
  const textEnd = textStart + rawText.length;

  return {
    indent,
    text: rawText,
    span: {
      from: absoluteOffset + textStart,
      to: absoluteOffset + textEnd,
      line: lineIndex + 1,
      column: textStart,
      depth,
      kind: "overflow-list",
    },
  };
}

function getIndentWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += char === "\t" ? 4 : 1;
  }
  return width;
}

function parseLinkedNoteLine(
  filePath: string,
  line: string,
  lineIndex: number,
  absoluteOffset: number,
  parentDepth: number,
  nodesById: Map<string, MindMapNode>,
): MindMapNode[] {
  const trimmed = line.trim();
  if (!PURE_WIKILINK_LINE_REGEX.test(trimmed)) {
    return [];
  }

  const nodes: MindMapNode[] = [];
  const lineStartOffset = line.length - line.trimStart().length;
  let linkIndex = 0;
  for (const match of trimmed.matchAll(/\[\[[^[\]]+?\]\]/g)) {
    const rawLink = match[0];
    const matchIndex = match.index ?? 0;
    const from = absoluteOffset + lineStartOffset + matchIndex;
    const to = from + rawLink.length;
    const node = createNode(
      filePath,
      rawLink,
      {
        kind: "linked-note",
        depth: parentDepth + 1,
        span: {
          from,
          to,
          line: lineIndex + 1,
          column: lineStartOffset + matchIndex,
          depth: parentDepth + 1,
          kind: "linked-note",
        },
      },
      nodesById,
      `linked-note:${filePath}:${lineIndex + 1}:${linkIndex}`,
    );
    nodes.push(node);
    linkIndex += 1;
  }

  return nodes;
}

function parseImageEmbedLine(
  filePath: string,
  line: string,
  lineIndex: number,
  absoluteOffset: number,
  parentDepth: number,
  nodesById: Map<string, MindMapNode>,
): MindMapNode[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const nodes: MindMapNode[] = [];
  const lineStartOffset = line.length - line.trimStart().length;
  let cursor = 0;
  let imageIndex = 0;

  for (const match of trimmed.matchAll(MARKDOWN_IMAGE_REGEX)) {
    const rawImage = match[0] ?? "";
    const matchIndex = match.index ?? 0;
    if (trimmed.slice(cursor, matchIndex).trim().length > 0) {
      return [];
    }

    const image = parseMarkdownImage(rawImage, match);
    const label = image.alt.trim().length > 0 ? image.alt.trim() : getImageFallbackLabel(image);
    const from = absoluteOffset + lineStartOffset + matchIndex;
    const to = from + rawImage.length;
    const node = createNode(
      filePath,
      label,
      {
        kind: "image-embed",
        depth: parentDepth + 1,
        span: {
          from,
          to,
          line: lineIndex + 1,
          column: lineStartOffset + matchIndex,
          depth: parentDepth + 1,
          kind: "image-embed",
        },
      },
      nodesById,
      `image-embed:${filePath}:${lineIndex + 1}:${imageIndex}`,
      {
        label,
        tokens: [
          {
            type: "text",
            raw: label,
            text: label,
          } as MindMapInlineToken,
        ],
        links: [],
        image,
      },
    );
    nodes.push(node);
    cursor = matchIndex + rawImage.length;
    imageIndex += 1;
  }

  if (nodes.length === 0 || trimmed.slice(cursor).trim().length > 0) {
    return [];
  }

  return nodes;
}

function parseMarkdownImage(raw: string, match: RegExpMatchArray): MindMapImageEmbed {
  const alt = match[1] ?? "";
  const rawTarget = match[2] ?? "";
  const title = match[3]?.trim() || undefined;
  const target =
    rawTarget.startsWith("<") && rawTarget.endsWith(">")
      ? rawTarget.slice(1, -1)
      : rawTarget;

  return {
    raw,
    alt,
    target,
    title,
  };
}

function getImageFallbackLabel(image: MindMapImageEmbed): string {
  const normalized = image.target.replace(/[#?].*$/, "");
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1]?.trim();
  return basename && basename.length > 0 ? basename : "Image";
}
