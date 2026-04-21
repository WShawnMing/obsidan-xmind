import { FOLD_BADGE_OFFSET } from "../constants";
import type {
  MindMapEdge,
  MindMapLayout,
  MindMapNode,
  NodeLayoutOffset,
  PositionedMindMapNode,
} from "../types";

const NODE_HEIGHT = 44;
const MIN_WIDTH = 140;
const MAX_WIDTH = 320;
const HORIZONTAL_GAP = 220;
const VERTICAL_GAP = 28;
const PADDING = 48;
const OUTSIDE_BADGE_SPACE = 64;

export function layoutMindMap(
  root: MindMapNode,
  layoutOffsets: Record<string, NodeLayoutOffset> = {},
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

    const width = estimateNodeWidth(node);
    const centerY =
      childCenters.length === 0
        ? leafCursor + NODE_HEIGHT / 2
        : (childCenters[0]! + childCenters[childCenters.length - 1]!) / 2;

    const offset = layoutOffsets[node.id] ?? { x: 0, y: 0 };

    nodes.set(node.id, {
      node,
      x: PADDING + depth * HORIZONTAL_GAP + offset.x,
      y: centerY - NODE_HEIGHT / 2 + offset.y,
      width,
      height: NODE_HEIGHT,
      depth,
    });

    if (childCenters.length === 0) {
      leafCursor += NODE_HEIGHT + VERTICAL_GAP;
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
    const curve = Math.max(26, (endX - branchAnchorX) * 0.34);

    return {
      parentId,
      childId,
      path: `M ${startX} ${startY} L ${branchAnchorX} ${startY} C ${branchAnchorX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`,
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

function estimateNodeWidth(node: MindMapNode): number {
  const length = node.label.length > 0 ? node.label.length : node.text.length;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, length * 8 + 56));
}
