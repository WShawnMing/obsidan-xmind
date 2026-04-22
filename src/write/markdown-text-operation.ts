import { parseMarkdownToMindMap } from "../parser/markdown-parser";
import type { MindMapDocument, MindMapNode, SourceDocumentRef } from "../types";
import {
  copyNodeSubtree,
  deleteNode,
  insertChildNode,
  insertSiblingNode,
  moveNode,
  pasteNodeSubtreeAfter,
  type CopiedMindMapSubtree,
  type InsertedNodeSelection,
  type MoveNodePosition,
  StructurePatchError,
} from "./structure-patch-writer";
import { patchNodeTitle, TitlePatchError } from "./title-patch-writer";

export type MarkdownTextOperationSelection =
  | {
      type: "inserted";
      selection: InsertedNodeSelection;
      startEditing: boolean;
    }
  | {
      type: "node-id";
      nodeId: string;
    };

export interface MarkdownTextOperationResult {
  content: string;
  label: string;
  showBanner: boolean;
  preserveLayout: boolean;
  nextSelection: MarkdownTextOperationSelection | null;
  restoreSelectionNodeId: string | null;
}

export function renameNodeInMarkdown(
  file: SourceDocumentRef,
  content: string,
  nodeId: string,
  nextTitle: string,
): MarkdownTextOperationResult {
  const document = parseMarkdownToMindMap(file, content);
  const node = requireTitleNode(document, nodeId);
  const nextContent = patchNodeTitle(content, node, nextTitle);

  return {
    content: nextContent,
    label: `Renamed “${node.label || node.text}”`,
    showBanner: false,
    preserveLayout: true,
    nextSelection: {
      type: "node-id",
      nodeId: node.id,
    },
    restoreSelectionNodeId: node.id,
  };
}

export function insertSiblingNodeInMarkdown(
  file: SourceDocumentRef,
  content: string,
  nodeId: string,
): MarkdownTextOperationResult {
  const document = parseMarkdownToMindMap(file, content);
  const node = requireStructuralNode(document, nodeId);
  const patch = insertSiblingNode(content, node);

  return {
    content: patch.content,
    label: `Added sibling near “${node.label || node.text}”`,
    showBanner: false,
    preserveLayout: false,
    nextSelection: patch.insertedNode
      ? {
          type: "inserted",
          selection: patch.insertedNode,
          startEditing: true,
        }
      : null,
    restoreSelectionNodeId: node.id,
  };
}

export function insertChildNodeInMarkdown(
  file: SourceDocumentRef,
  content: string,
  nodeId: string,
): MarkdownTextOperationResult {
  const document = parseMarkdownToMindMap(file, content);
  const node = requireInsertableNode(document, nodeId);
  const patch = insertChildNode(content, node);

  return {
    content: patch.content,
    label: `Added child to “${node.label || node.text}”`,
    showBanner: false,
    preserveLayout: false,
    nextSelection: patch.insertedNode
      ? {
          type: "inserted",
          selection: patch.insertedNode,
          startEditing: true,
        }
      : null,
    restoreSelectionNodeId: node.id,
  };
}

export function deleteNodeInMarkdown(
  file: SourceDocumentRef,
  content: string,
  nodeId: string,
): MarkdownTextOperationResult {
  const document = parseMarkdownToMindMap(file, content);
  const node = requireStructuralNode(document, nodeId);
  const parent = findParentNode(document.root, node.id);
  const nextContent = deleteNode(content, document, node);

  return {
    content: nextContent,
    label: `Deleted “${node.label || node.text}”`,
    showBanner: true,
    preserveLayout: false,
    nextSelection: parent
      ? {
          type: "node-id",
          nodeId: parent.id,
        }
      : null,
    restoreSelectionNodeId: node.id,
  };
}

export function moveNodeInMarkdown(
  file: SourceDocumentRef,
  content: string,
  sourceNodeId: string,
  targetNodeId: string,
  position: MoveNodePosition,
): MarkdownTextOperationResult {
  const document = parseMarkdownToMindMap(file, content);
  const sourceNode = requireStructuralNode(document, sourceNodeId);
  const targetNode = requireExistingNode(document, targetNodeId);
  const patch = moveNode(
    content,
    document,
    sourceNode,
    targetNode,
    position,
  );

  return {
    content: patch.content,
    label: `Moved “${sourceNode.label || sourceNode.text}”`,
    showBanner: false,
    preserveLayout: false,
    nextSelection: patch.insertedNode
      ? {
          type: "inserted",
          selection: patch.insertedNode,
          startEditing: false,
        }
      : null,
    restoreSelectionNodeId: sourceNode.id,
  };
}

export function pasteNodeSubtreeAfterInMarkdown(
  file: SourceDocumentRef,
  content: string,
  targetNodeId: string,
  copied: CopiedMindMapSubtree,
): MarkdownTextOperationResult {
  const document = parseMarkdownToMindMap(file, content);
  const targetNode = requireExistingNode(document, targetNodeId);
  const patch = pasteNodeSubtreeAfter(content, document, targetNode, copied);

  return {
    content: patch.content,
    label:
      targetNode.source.kind === "virtual-root"
        ? `Pasted “${copied.text}” into root`
        : `Pasted “${copied.text}” after “${targetNode.label || targetNode.text}”`,
    showBanner: false,
    preserveLayout: false,
    nextSelection: patch.insertedNode
      ? {
          type: "inserted",
          selection: patch.insertedNode,
          startEditing: false,
        }
      : null,
    restoreSelectionNodeId: targetNode.id,
  };
}

export function copyNodeSubtreeFromMarkdown(
  file: SourceDocumentRef,
  content: string,
  nodeId: string,
): CopiedMindMapSubtree {
  const document = parseMarkdownToMindMap(file, content);
  const node = requireStructuralNode(document, nodeId);
  return copyNodeSubtree(content, node);
}

function requireExistingNode(document: MindMapDocument, nodeId: string): MindMapNode {
  const node = document.nodesById.get(nodeId);
  if (!node) {
    throw new StructurePatchError(
      "STALE_SOURCE",
      "The Markdown note changed before this topic action could be applied.",
    );
  }
  return node;
}

function requireStructuralNode(document: MindMapDocument, nodeId: string): MindMapNode {
  const node = requireExistingNode(document, nodeId);
  if (node.source.kind === "virtual-root") {
    throw new StructurePatchError(
      "INVALID_TARGET",
      "The canvas root cannot be edited as a standalone topic.",
    );
  }
  if (node.source.kind === "linked-note" || node.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Derived attachment items are read-only in the mind map.",
    );
  }
  return node;
}

function requireInsertableNode(document: MindMapDocument, nodeId: string): MindMapNode {
  const node = requireExistingNode(document, nodeId);
  if (node.source.kind === "linked-note" || node.source.kind === "image-embed") {
    throw new StructurePatchError(
      "NOT_EDITABLE",
      "Derived attachment items are read-only in the mind map.",
    );
  }
  return node;
}

function requireTitleNode(document: MindMapDocument, nodeId: string): MindMapNode {
  const node = requireExistingNode(document, nodeId);
  if (
    node.source.kind === "virtual-root" ||
    node.source.kind === "linked-note" ||
    node.source.kind === "image-embed"
  ) {
    throw new TitlePatchError("NOT_EDITABLE", "Only structural Markdown nodes can be renamed.");
  }
  return node;
}

function findParentNode(root: MindMapNode, targetId: string): MindMapNode | null {
  for (const child of root.children) {
    if (child.id === targetId) {
      return root;
    }

    const nested = findParentNode(child, targetId);
    if (nested) {
      return nested;
    }
  }

  return null;
}
