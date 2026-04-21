import type { MindMapDocument, MindMapNode } from "../types";

const HEADING_REGEX = /^(#{1,6})([ \t]+)(.*?)([ \t]+#+[ \t]*)?$/;
const LIST_ITEM_REGEX = /^(\s*)([-+*]|\d+[.)])([ \t]+)(.*)$/;
const DEFAULT_NEW_TOPIC_TITLE = "New topic";

export type StructurePatchErrorCode =
  | "INVALID_TARGET"
  | "NOT_EDITABLE"
  | "STALE_SOURCE";

export interface InsertedNodeSelection {
  kind: "heading" | "overflow-list";
  depth: number;
  line: number;
  text: string;
}

export interface StructurePatchResult {
  content: string;
  insertedNode?: InsertedNodeSelection;
}

interface LineState {
  lines: string[];
  documentEndIndex: number;
}

interface ParsedListLine {
  indent: number;
  marker: string;
  text: string;
}

export class StructurePatchError extends Error {
  code: StructurePatchErrorCode;

  constructor(code: StructurePatchErrorCode, message: string) {
    super(message);
    this.name = "StructurePatchError";
    this.code = code;
  }
}

export function insertSiblingNode(
  content: string,
  node: MindMapNode,
): StructurePatchResult {
  if (node.source.kind === "virtual-root") {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "The canvas root does not support sibling topics.",
    );
  }

  if (node.source.kind === "linked-note") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Linked-note items are derived from Markdown and cannot create sibling topics yet.",
    );
  }

  const state = buildLineState(content);
  const insertionIndex = getSubtreeEndIndex(state.lines, node);

  if (node.source.kind === "heading") {
    validateHeadingLine(state.lines, node);
    const line = buildHeadingLine(node.source.depth, DEFAULT_NEW_TOPIC_TITLE);
    state.lines.splice(insertionIndex, 0, line);
    return {
      content: state.lines.join("\n"),
      insertedNode: {
        kind: "heading",
        depth: node.source.depth,
        line: insertionIndex + 1,
        text: DEFAULT_NEW_TOPIC_TITLE,
      },
    };
  }

  validateOverflowListLine(state.lines, node);
  const sourceLine = parseListSourceLine(getNodeLine(state.lines, node));
  if (!sourceLine) {
    throw new StructurePatchError("STALE_SOURCE", "The Markdown list item changed.");
  }

  const line = buildListLine(
    sourceLine.indent,
    normalizeListMarker(sourceLine.marker),
    DEFAULT_NEW_TOPIC_TITLE,
  );
  state.lines.splice(insertionIndex, 0, line);

  return {
    content: state.lines.join("\n"),
    insertedNode: {
      kind: "overflow-list",
      depth: node.source.depth,
      line: insertionIndex + 1,
      text: DEFAULT_NEW_TOPIC_TITLE,
    },
  };
}

export function insertChildNode(
  content: string,
  node: MindMapNode,
): StructurePatchResult {
  if (node.source.kind === "linked-note") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Linked-note items are derived from Markdown and cannot create child topics yet.",
    );
  }

  const state = buildLineState(content);

  if (node.source.kind === "virtual-root") {
    state.lines.splice(
      state.documentEndIndex,
      0,
      buildHeadingLine(1, DEFAULT_NEW_TOPIC_TITLE),
    );
    return {
      content: state.lines.join("\n"),
      insertedNode: {
        kind: "heading",
        depth: 1,
        line: state.documentEndIndex + 1,
        text: DEFAULT_NEW_TOPIC_TITLE,
      },
    };
  }

  const insertionIndex = getSubtreeEndIndex(state.lines, node);

  if (node.source.kind === "heading") {
    validateHeadingLine(state.lines, node);

    if (node.source.depth < 6) {
      state.lines.splice(
        insertionIndex,
        0,
        buildHeadingLine(node.source.depth + 1, DEFAULT_NEW_TOPIC_TITLE),
      );
      return {
        content: state.lines.join("\n"),
        insertedNode: {
          kind: "heading",
          depth: node.source.depth + 1,
          line: insertionIndex + 1,
          text: DEFAULT_NEW_TOPIC_TITLE,
        },
      };
    }

    state.lines.splice(
      insertionIndex,
      0,
      buildListLine(0, "-", DEFAULT_NEW_TOPIC_TITLE),
    );
    return {
      content: state.lines.join("\n"),
      insertedNode: {
        kind: "overflow-list",
        depth: 7,
        line: insertionIndex + 1,
        text: DEFAULT_NEW_TOPIC_TITLE,
      },
    };
  }

  validateOverflowListLine(state.lines, node);
  const sourceLine = parseListSourceLine(getNodeLine(state.lines, node));
  if (!sourceLine) {
    throw new StructurePatchError("STALE_SOURCE", "The Markdown list item changed.");
  }

  state.lines.splice(
    insertionIndex,
    0,
    buildListLine(
      sourceLine.indent + 2,
      normalizeListMarker(sourceLine.marker),
      DEFAULT_NEW_TOPIC_TITLE,
    ),
  );
  return {
    content: state.lines.join("\n"),
    insertedNode: {
      kind: "overflow-list",
      depth: node.source.depth + 1,
      line: insertionIndex + 1,
      text: DEFAULT_NEW_TOPIC_TITLE,
    },
  };
}

export function deleteNode(
  content: string,
  document: MindMapDocument,
  node: MindMapNode,
): string {
  if (node.source.kind === "virtual-root") {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "The canvas root cannot be deleted.",
    );
  }

  if (node.source.kind === "linked-note") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Linked-note items are derived from Markdown and cannot be deleted yet.",
    );
  }

  if (document.root.id === node.id) {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "The root topic cannot be deleted.",
    );
  }

  const state = buildLineState(content);
  const startIndex = getNodeLineIndex(node);
  const endIndex = getSubtreeEndIndex(state.lines, node);

  if (node.source.kind === "heading") {
    validateHeadingLine(state.lines, node);
  } else {
    validateOverflowListLine(state.lines, node);
  }

  state.lines.splice(startIndex, endIndex - startIndex);
  return state.lines.join("\n");
}

function buildLineState(content: string): LineState {
  const lines = content.split("\n");
  return {
    lines,
    documentEndIndex: getDocumentEndIndex(lines),
  };
}

function getDocumentEndIndex(lines: string[]): number {
  if (lines.length === 0) {
    return 0;
  }

  if (lines[lines.length - 1] === "") {
    return Math.max(0, lines.length - 1);
  }

  return lines.length;
}

function getSubtreeEndIndex(lines: string[], node: MindMapNode): number {
  return node.source.kind === "overflow-list"
    ? findOverflowSubtreeEnd(lines, node)
    : findHeadingSubtreeEnd(lines, node);
}

function findHeadingSubtreeEnd(lines: string[], node: MindMapNode): number {
  const startIndex = getNodeLineIndex(node);
  const endIndex = getDocumentEndIndex(lines);
  let fenceMarker: string | null = null;
  let fenceLength = 0;

  for (let lineIndex = startIndex + 1; lineIndex < endIndex; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? "";
      const length = fenceMatch[1]?.length ?? 0;
      if (!fenceMarker) {
        fenceMarker = marker;
        fenceLength = length;
      } else if (fenceMarker === marker && length >= fenceLength) {
        fenceMarker = null;
        fenceLength = 0;
      }
      continue;
    }

    if (fenceMarker) {
      continue;
    }

    const heading = parseHeadingSourceLine(line);
    if (heading && heading.depth <= node.source.depth) {
      return lineIndex;
    }
  }

  return endIndex;
}

function findOverflowSubtreeEnd(lines: string[], node: MindMapNode): number {
  const startIndex = getNodeLineIndex(node);
  const endIndex = getDocumentEndIndex(lines);
  const sourceLine = parseListSourceLine(getNodeLine(lines, node));
  if (!sourceLine) {
    throw new StructurePatchError("STALE_SOURCE", "The Markdown list item changed.");
  }

  for (let lineIndex = startIndex + 1; lineIndex < endIndex; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    if (line.trim().length === 0) {
      continue;
    }

    if (parseHeadingSourceLine(line)) {
      return lineIndex;
    }

    const listLine = parseListSourceLine(line);
    if (listLine) {
      if (listLine.indent <= sourceLine.indent) {
        return lineIndex;
      }
      continue;
    }

    if (getIndentWidth(line) <= sourceLine.indent) {
      return lineIndex;
    }
  }

  return endIndex;
}

function validateHeadingLine(lines: string[], node: MindMapNode): void {
  const heading = parseHeadingSourceLine(getNodeLine(lines, node));
  if (!heading || heading.depth !== node.source.depth || heading.text !== node.text) {
    throw new StructurePatchError(
      "STALE_SOURCE",
      "The Markdown heading changed after the mind map was parsed.",
    );
  }
}

function validateOverflowListLine(lines: string[], node: MindMapNode): void {
  const listLine = parseListSourceLine(getNodeLine(lines, node));
  if (!listLine || listLine.text !== node.text) {
    throw new StructurePatchError(
      "STALE_SOURCE",
      "The Markdown list item changed after the mind map was parsed.",
    );
  }
}

function getNodeLine(lines: string[], node: MindMapNode): string {
  return lines[getNodeLineIndex(node)] ?? "";
}

function getNodeLineIndex(node: MindMapNode): number {
  const line = node.source.span?.line;
  if (!line) {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "This topic cannot be edited from the mind map yet.",
    );
  }

  return Math.max(0, line - 1);
}

function buildHeadingLine(depth: number, text: string): string {
  return `${"#".repeat(depth)} ${text}`;
}

function buildListLine(indent: number, marker: string, text: string): string {
  return `${" ".repeat(indent)}${marker} ${text}`;
}

function parseHeadingSourceLine(
  line: string,
): {
  depth: number;
  text: string;
} | null {
  const match = line.match(HEADING_REGEX);
  if (!match) {
    return null;
  }

  return {
    depth: (match[1] ?? "").length,
    text: match[3] ?? "",
  };
}

function parseListSourceLine(line: string): ParsedListLine | null {
  const match = line.match(LIST_ITEM_REGEX);
  if (!match) {
    return null;
  }

  return {
    indent: getIndentWidth(match[1] ?? ""),
    marker: match[2] ?? "-",
    text: match[4] ?? "",
  };
}

function normalizeListMarker(marker: string): string {
  return /^\d+[.)]$/.test(marker) ? "1." : marker;
}

function getIndentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") {
      width += 1;
      continue;
    }
    if (char === "\t") {
      width += 4;
      continue;
    }
    break;
  }
  return width;
}
