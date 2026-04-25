import { FOLD_BADGE_OFFSET } from "../constants";
import type {
  MindMapConnectionStyle,
  MindMapEdge,
  MindMapLayout,
  MindMapNode,
  NodeLayoutOffset,
  NodeSizeOverride,
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
const MIN_TEXT_NODE_WIDTH = 120;
const MIN_TEXT_NODE_HEIGHT = NODE_HEIGHT;
const MIN_IMAGE_NODE_WIDTH = 160;
const MIN_IMAGE_NODE_HEIGHT = 120;
const MAX_MANUAL_NODE_WIDTH = 920;
const MAX_MANUAL_NODE_HEIGHT = 680;

export function layoutMindMap(
  root: MindMapNode,
  layoutOffsets: Record<string, NodeLayoutOffset> = {},
  connectionStyle: MindMapConnectionStyle = "curved",
  sizeOverrides: Record<string, NodeSizeOverride> = {},
): MindMapLayout {
  const nodes = new Map<string, PositionedMindMapNode>();
  const edgePairs: Array<{ parentId: string; childId: string }> = [];
  const subtreeHeights = new Map<string, number>();

  const measure = (node: MindMapNode): number => {
    const visibleChildren = node.collapsed ? [] : node.children;
    const size = estimateNodeSize(node, sizeOverrides[node.id]);
    if (visibleChildren.length === 0) {
      subtreeHeights.set(node.id, size.height);
      return size.height;
    }

    let childrenHeight = 0;
    for (const child of visibleChildren) {
      childrenHeight += measure(child);
    }
    childrenHeight += VERTICAL_GAP * Math.max(0, visibleChildren.length - 1);
    const subtreeHeight = Math.max(size.height, childrenHeight);
    subtreeHeights.set(node.id, subtreeHeight);
    return subtreeHeight;
  };

  const visit = (node: MindMapNode, depth: number, top: number): void => {
    const visibleChildren = node.collapsed ? [] : node.children;
    const size = estimateNodeSize(node, sizeOverrides[node.id]);
    const subtreeHeight = subtreeHeights.get(node.id) ?? size.height;
    const centerY = top + subtreeHeight / 2;

    const offset = layoutOffsets[node.id] ?? { x: 0, y: 0 };

    nodes.set(node.id, {
      node,
      x: PADDING + depth * HORIZONTAL_GAP + offset.x,
      y: centerY - size.height / 2 + offset.y,
      width: size.width,
      height: size.height,
      depth,
    });

    if (visibleChildren.length === 0) {
      return;
    }

    const childSubtreeHeight =
      visibleChildren.reduce(
        (sum, child) => sum + (subtreeHeights.get(child.id) ?? 0),
        0,
      ) +
      VERTICAL_GAP * Math.max(0, visibleChildren.length - 1);
    let childTop = top + (subtreeHeight - childSubtreeHeight) / 2;

    for (const child of visibleChildren) {
      const childHeight = subtreeHeights.get(child.id) ?? 0;
      visit(child, depth + 1, childTop);
      edgePairs.push({
        parentId: node.id,
        childId: child.id,
      });
      childTop += childHeight + VERTICAL_GAP;
    }
  };

  measure(root);
  visit(root, 0, 0);

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

function estimateNodeSize(
  node: MindMapNode,
  override?: NodeSizeOverride,
): { width: number; height: number } {
  if (node.source.kind === "image-embed") {
    if (override) {
      return {
        width: clampDimension(override.width, MIN_IMAGE_NODE_WIDTH, MAX_MANUAL_NODE_WIDTH),
        height: clampDimension(override.height, MIN_IMAGE_NODE_HEIGHT, MAX_MANUAL_NODE_HEIGHT),
      };
    }

    return {
      width: IMAGE_NODE_WIDTH,
      height: IMAGE_NODE_HEIGHT,
    };
  }

  if (override) {
    return {
      width: clampDimension(override.width, MIN_TEXT_NODE_WIDTH, MAX_MANUAL_NODE_WIDTH),
      height: clampDimension(override.height, MIN_TEXT_NODE_HEIGHT, MAX_MANUAL_NODE_HEIGHT),
    };
  }

  const length = node.label.length > 0 ? node.label.length : node.text.length;
  return {
    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, length * 8 + 56)),
    height: NODE_HEIGHT,
  };
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}
