import type { MindMapNode } from "../types";

export function findNavigationTarget(
  root: MindMapNode,
  currentNodeId: string,
  direction: "left" | "right" | "up" | "down",
): string {
  const currentNode = findNodeById(root, currentNodeId);
  if (!currentNode) {
    return currentNodeId;
  }

  if (direction === "right") {
    return currentNode.children[0]?.id ?? currentNodeId;
  }

  const parent = findParentNode(root, currentNodeId);
  if (direction === "left") {
    return parent?.id ?? currentNodeId;
  }

  if (!parent) {
    return currentNodeId;
  }

  const siblings = parent.children;
  const index = siblings.findIndex((node) => node.id === currentNodeId);
  if (index === -1) {
    return currentNodeId;
  }

  if (direction === "up") {
    return siblings[index - 1]?.id ?? currentNodeId;
  }

  return siblings[index + 1]?.id ?? currentNodeId;
}

export function findParentNode(root: MindMapNode, targetId: string): MindMapNode | null {
  for (const child of root.children) {
    if (child.id === targetId) {
      return root;
    }

    const parent = findParentNode(child, targetId);
    if (parent) {
      return parent;
    }
  }

  return null;
}

function findNodeById(root: MindMapNode, targetId: string): MindMapNode | null {
  if (root.id === targetId) {
    return root;
  }

  for (const child of root.children) {
    const found = findNodeById(child, targetId);
    if (found) {
      return found;
    }
  }

  return null;
}
