import { FOLD_BADGE_OFFSET } from "../constants";
import type {
  MindMapConnectionStyle,
  MindMapEdge,
  MindMapLayout,
  MindMapNode,
  NodeLayoutOffset,
  PositionedMindMapNode,
} from "../types";

const NODE_HEIGHT = 44;
const MIN_WIDTH = 140;
const MAX_WIDTH = 320;
const IMAGE_NODE_WIDTH = 216;
const IMAGE_NODE_HEIGHT = 164;
const HORIZONTAL_GAP = 220;
const VERTICAL_GAP = 28;
const PADDING = 48;
const OUTSIDE_BADGE_SPACE = 64;

export function layoutMindMap(
  root: MindMapNode,
  layoutOffsets: Record<string, NodeLayoutOffset> = {},
  connectionStyle: MindMapConnectionStyle = "curved",
): MindMapLayout {
  const nodes = new Map<string, PositionedMindMapNode>();
  const edgePairs: Array<{ parentId: string; childId: string }> = [];
  let leafCursor = 0;

  const visit = (node: MindMapNode, depth: number): number => {
    const visibleChildren = node.collapsed ? [] : node.children;
    const childCenters: number[] = [];

    for (const child of visibleChildren) {
      childCenters.push(visit(child, depth + 1));
      edgePairs.push({
        parentId: node.id,
        childId: child.id,
      });
    }

    const size = estimateNodeSize(node);
    const centerY =
      childCenters.length === 0
        ? leafCursor + size.height / 2
        : (childCenters[0]! + childCenters[childCenters.length - 1]!) / 2;

    const offset = layoutOffsets[node.id] ?? { x: 0, y: 0 };

    nodes.set(node.id, {
      node,
      x: PADDING + depth * HORIZONTAL_GAP + offset.x,
      y: centerY - size.height / 2 + offset.y,
      width: size.width,
      height: size.height,
      depth,
    });

    if (childCenters.length === 0) {
      leafCursor += size.height + VERTICAL_GAP;
    }

    return centerY;
  };

  visit(root, 0);

  const edges: MindMapEdge[] = edgePairs.map(({ parentId, childId }) => {
    const parent = nodes.get(parentId);
    const child = nodes.get(childId);

    if (!parent || !child) {
      return {
        parentId,
        childId,
        path: "",
      };
    }

    const startX = parent.x + parent.width;
    const startY = parent.y + parent.height / 2;
    const endX = child.x;
    const endY = child.y + child.height / 2;
    const branchAnchorX = startX + FOLD_BADGE_OFFSET;

    return {
      parentId,
      childId,
      path: buildEdgePath(
        connectionStyle,
        startX,
        startY,
        branchAnchorX,
        endX,
        endY,
      ),
    };
  });

  let maxWidth = 0;
  let maxHeight = 0;
  for (const positioned of nodes.values()) {
    maxWidth = Math.max(maxWidth, positioned.x + positioned.width);
    maxHeight = Math.max(maxHeight, positioned.y + positioned.height);
  }

  return {
    nodes,
    edges,
    bounds: {
      width: maxWidth + PADDING + OUTSIDE_BADGE_SPACE,
      height: maxHeight + PADDING,
    },
  };
}

function buildEdgePath(
  connectionStyle: MindMapConnectionStyle,
  startX: number,
  startY: number,
  branchAnchorX: number,
  endX: number,
  endY: number,
): string {
  if (connectionStyle === "straight") {
    return `M ${startX} ${startY} L ${endX} ${endY}`;
  }

  if (connectionStyle === "angled") {
    const bendX = Math.max(branchAnchorX, startX + (endX - startX) * 0.52);
    return `M ${startX} ${startY} L ${branchAnchorX} ${startY} L ${bendX} ${startY} L ${bendX} ${endY} L ${endX} ${endY}`;
  }

  const curve = Math.max(26, (endX - branchAnchorX) * 0.34);
  return `M ${startX} ${startY} L ${branchAnchorX} ${startY} C ${branchAnchorX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
}

function estimateNodeSize(node: MindMapNode): { width: number; height: number } {
  if (node.source.kind === "image-embed") {
    return {
      width: IMAGE_NODE_WIDTH,
      height: IMAGE_NODE_HEIGHT,
    };
  }

  const length = node.label.length > 0 ? node.label.length : node.text.length;
  return {
    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, length * 8 + 56)),
    height: NODE_HEIGHT,
  };
}
