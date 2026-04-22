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

export type MoveNodePosition = "before" | "after" | "child";

export interface CopiedMindMapSubtree {
  rootKind: "heading" | "overflow-list";
  rootDepth: number;
  text: string;
  lines: string[];
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

  if (node.source.kind === "linked-note" || node.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Derived attachment items are read-only in the mind map.",
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
  if (node.source.kind === "linked-note" || node.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Derived attachment items are read-only in the mind map.",
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

  if (node.source.kind === "linked-note" || node.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Derived attachment items are read-only in the mind map.",
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

export function copyNodeSubtree(
  content: string,
  node: MindMapNode,
): CopiedMindMapSubtree {
  if (node.source.kind === "virtual-root") {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "The canvas root cannot be copied as a standalone topic.",
    );
  }

  if (node.source.kind === "linked-note" || node.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Derived attachment items are read-only in the mind map.",
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

  return {
    rootKind: node.source.kind,
    rootDepth: node.source.depth,
    text: node.text,
    lines: state.lines.slice(startIndex, endIndex),
  };
}

export function pasteNodeSubtreeAfter(
  content: string,
  document: MindMapDocument,
  targetNode: MindMapNode,
  copied: CopiedMindMapSubtree,
): StructurePatchResult {
  if (targetNode.source.kind === "linked-note" || targetNode.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Paste after derived attachment items is not supported yet.",
    );
  }

  const state = buildLineState(content);
  const targetRoot =
    targetNode.source.kind === "virtual-root"
      ? getMoveTargetSpec(state.lines, targetNode, "child")
      : getMoveTargetSpec(state.lines, targetNode, "after");

  const syntheticNode: MindMapNode = {
    id: `clipboard:${copied.rootKind}:${copied.rootDepth}:${copied.text}`,
    text: copied.text,
    label: copied.text,
    tokens: [],
    links: [],
    children: [],
    collapsed: false,
    source: {
      kind: copied.rootKind,
      depth: copied.rootDepth,
    },
  };

  const transformedBlock = rewriteMovedBlock(copied.lines, syntheticNode, targetRoot);
  state.lines.splice(targetRoot.insertionIndex, 0, ...transformedBlock);

  return {
    content: state.lines.join("\n"),
    insertedNode: {
      kind: targetRoot.kind,
      depth: targetRoot.depth,
      line: targetRoot.insertionIndex + 1,
      text: copied.text,
    },
  };
}

export function moveNode(
  content: string,
  document: MindMapDocument,
  node: MindMapNode,
  targetNode: MindMapNode,
  position: MoveNodePosition,
): StructurePatchResult {
  validateMovableNode(node, document);

  if (targetNode.source.kind === "linked-note" || targetNode.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Derived attachment items cannot be used as drag targets yet.",
    );
  }

  if (position !== "child" && targetNode.source.kind === "virtual-root") {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "The canvas root only accepts child drops.",
    );
  }

  if (node.id === targetNode.id) {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "A topic cannot be dropped onto itself.",
    );
  }

  if (hasDescendant(node, targetNode.id)) {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "A topic cannot be dropped onto one of its descendants.",
    );
  }

  const state = buildLineState(content);
  const sourceStartIndex = getNodeLineIndex(node);
  const sourceEndIndex = getSubtreeEndIndex(state.lines, node);
  const sourceBlock = state.lines.slice(sourceStartIndex, sourceEndIndex);

  if (sourceBlock.length === 0) {
    throw new StructurePatchError("STALE_SOURCE", "The source topic could not be moved.");
  }

  const targetRoot = getMoveTargetSpec(state.lines, targetNode, position);
  const transformedBlock = rewriteMovedBlock(sourceBlock, node, targetRoot);

  state.lines.splice(sourceStartIndex, sourceEndIndex - sourceStartIndex);

  const removedLineCount = sourceEndIndex - sourceStartIndex;
  const insertionIndex = getAdjustedInsertionIndex(
    state.lines,
    removedLineCount,
    sourceStartIndex,
    targetRoot.insertionIndex,
  );

  state.lines.splice(insertionIndex, 0, ...transformedBlock);

  return {
    content: state.lines.join("\n"),
    insertedNode: {
      kind: targetRoot.kind,
      depth: targetRoot.depth,
      line: insertionIndex + 1,
      text: node.text,
    },
  };
}

function buildLineState(content: string): LineState {
  const lines = content.split("\n");
  return {
    lines,
    documentEndIndex: getDocumentEndIndex(lines),
  };
}

function validateMovableNode(node: MindMapNode, document: MindMapDocument): void {
  if (node.source.kind === "virtual-root") {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "The canvas root cannot be moved.",
    );
  }

  if (node.source.kind === "linked-note" || node.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Derived attachment items cannot be moved yet.",
    );
  }

  if (document.root.id === node.id) {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "The root topic cannot be moved.",
    );
  }
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

interface MoveTargetSpec {
  kind: "heading" | "overflow-list";
  depth: number;
  indent: number;
  insertionIndex: number;
}

function getMoveTargetSpec(
  lines: string[],
  targetNode: MindMapNode,
  position: MoveNodePosition,
): MoveTargetSpec {
  if (position === "child") {
    if (targetNode.source.kind === "virtual-root") {
      return {
        kind: "heading",
        depth: 1,
        indent: 0,
        insertionIndex: getDocumentEndIndex(lines),
      };
    }

    if (targetNode.source.kind === "heading") {
      validateHeadingLine(lines, targetNode);
      return targetNode.source.depth < 6
        ? {
            kind: "heading",
            depth: targetNode.source.depth + 1,
            indent: 0,
            insertionIndex: getSubtreeEndIndex(lines, targetNode),
          }
        : {
            kind: "overflow-list",
            depth: 7,
            indent: 0,
            insertionIndex: getSubtreeEndIndex(lines, targetNode),
          };
    }

    validateOverflowListLine(lines, targetNode);
    const listLine = parseListSourceLine(getNodeLine(lines, targetNode));
    if (!listLine) {
      throw new StructurePatchError("STALE_SOURCE", "The target topic changed.");
    }

    return {
      kind: "overflow-list",
      depth: targetNode.source.depth + 1,
      indent: listLine.indent + 2,
      insertionIndex: getSubtreeEndIndex(lines, targetNode),
    };
  }

  if (targetNode.source.kind === "heading") {
    validateHeadingLine(lines, targetNode);
    return {
      kind: "heading",
      depth: targetNode.source.depth,
      indent: 0,
      insertionIndex:
        position === "before"
          ? getNodeLineIndex(targetNode)
          : getSubtreeEndIndex(lines, targetNode),
    };
  }

  validateOverflowListLine(lines, targetNode);
  const listLine = parseListSourceLine(getNodeLine(lines, targetNode));
  if (!listLine) {
    throw new StructurePatchError("STALE_SOURCE", "The target topic changed.");
  }

  return {
    kind: "overflow-list",
    depth: targetNode.source.depth,
    indent: listLine.indent,
    insertionIndex:
      position === "before"
        ? getNodeLineIndex(targetNode)
        : getSubtreeEndIndex(lines, targetNode),
  };
}

function getAdjustedInsertionIndex(
  lines: string[],
  removedLineCount: number,
  sourceStartIndex: number,
  originalInsertionIndex: number,
): number {
  const adjusted =
    sourceStartIndex < originalInsertionIndex
      ? originalInsertionIndex - removedLineCount
      : originalInsertionIndex;
  return Math.max(0, Math.min(getDocumentEndIndex(lines), adjusted));
}

function rewriteMovedBlock(
  sourceBlock: string[],
  node: MindMapNode,
  targetRoot: MoveTargetSpec,
): string[] {
  const rewritten: string[] = [];
  const sourceRootDepth = node.source.depth;
  const sourceRootIndent = getRootIndent(node, sourceBlock[0] ?? "");
  let currentSourceContextDepth = sourceRootDepth;
  let currentTargetContextDepth = targetRoot.depth;

  for (const line of sourceBlock) {
    if (line.trim().length === 0) {
      rewritten.push(line);
      continue;
    }

    const heading = parseHeadingSourceLine(line);
    if (heading) {
      const relativeDepth = heading.depth - sourceRootDepth;
      const nextDepth = targetRoot.depth + relativeDepth;
      currentSourceContextDepth = heading.depth;
      currentTargetContextDepth = nextDepth;
      rewritten.push(rewriteStructuralLine(heading.text, nextDepth, "-"));
      continue;
    }

    const listLine = parseListSourceLine(line);
    if (listLine) {
      const relativeDepth = 7 + Math.floor(listLine.indent / 2) - sourceRootDepth;
      const nextDepth = targetRoot.depth + relativeDepth;
      currentSourceContextDepth = 7 + Math.floor(listLine.indent / 2);
      currentTargetContextDepth = nextDepth;
      rewritten.push(rewriteStructuralLine(listLine.text, nextDepth, listLine.marker));
      continue;
    }

    const currentIndent = getIndentWidth(line);
    const bodySourceBaseIndent = getBodyBaseIndent(currentSourceContextDepth, sourceRootIndent);
    const bodyTargetBaseIndent = getBodyBaseIndent(currentTargetContextDepth, targetRoot.indent);
    const relativeExtraIndent = Math.max(0, currentIndent - bodySourceBaseIndent);
    rewritten.push(rewriteBodyLine(line, bodyTargetBaseIndent + relativeExtraIndent));
  }

  return rewritten;
}

function rewriteStructuralLine(text: string, semanticDepth: number, marker: string): string {
  if (semanticDepth <= 6) {
    return buildHeadingLine(semanticDepth, text);
  }

  return buildListLine(getListIndent(semanticDepth), normalizeListMarker(marker), text);
}

function rewriteBodyLine(line: string, nextIndent: number): string {
  const trimmed = line.trimStart();
  return `${" ".repeat(nextIndent)}${trimmed}`;
}

function getRootIndent(node: MindMapNode, rootLine: string): number {
  if (node.source.kind !== "overflow-list") {
    return 0;
  }

  const parsed = parseListSourceLine(rootLine);
  return parsed?.indent ?? 0;
}

function getListIndent(semanticDepth: number): number {
  return Math.max(0, (semanticDepth - 7) * 2);
}

function getBodyBaseIndent(semanticDepth: number, rootIndent: number): number {
  if (semanticDepth <= 6) {
    return 0;
  }

  if (semanticDepth === 7) {
    return rootIndent + 2;
  }

  return getListIndent(semanticDepth) + 2;
}

function hasDescendant(node: MindMapNode, targetId: string): boolean {
  for (const child of node.children) {
    if (child.id === targetId || hasDescendant(child, targetId)) {
      return true;
    }
  }

  return false;
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
