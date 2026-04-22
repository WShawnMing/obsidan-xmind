import type {
  MindMapAssociation,
  MindMapAssociationEndpoint,
  MindMapDocument,
  MindMapNode,
  MindMapNodeLocator,
  NodeKind,
} from "./types";

interface NodeContext {
  node: MindMapNode;
  parentId: string | null;
  ancestorTexts: string[];
  siblingIndex: number;
  subtreeSignature: string;
}

interface DocumentIndex {
  byNodeId: Map<string, NodeContext>;
  candidatesByKey: Map<string, NodeContext[]>;
}

export function buildAssociationEndpoint(
  document: MindMapDocument,
  nodeId: string,
): MindMapAssociationEndpoint | null {
  const index = buildDocumentIndex(document);
  const context = index.byNodeId.get(nodeId);
  if (!context || context.node.source.kind === "virtual-root") {
    return null;
  }

  return {
    nodeId: context.node.id,
    locator: {
      kind: context.node.source.kind,
      text: context.node.text,
      depth: context.node.source.depth,
      ancestorTexts: [...context.ancestorTexts],
      siblingIndex: context.siblingIndex,
      subtreeSignature: context.subtreeSignature,
    },
  };
}

export function resolveAssociationEndpoint(
  document: MindMapDocument,
  endpoint: MindMapAssociationEndpoint,
): MindMapNode | null {
  const index = buildDocumentIndex(document);
  return resolveAssociationEndpointWithIndex(index, endpoint);
}

export function reconcileAssociations(
  document: MindMapDocument,
  associations: MindMapAssociation[],
): {
  associations: MindMapAssociation[];
  changed: boolean;
} {
  const index = buildDocumentIndex(document);
  const next: MindMapAssociation[] = [];
  let changed = false;

  for (const association of associations) {
    const fromNode = resolveAssociationEndpointWithIndex(index, association.from);
    const toNode = resolveAssociationEndpointWithIndex(index, association.to);
    if (!fromNode || !toNode || fromNode.id === toNode.id) {
      changed = true;
      continue;
    }

    const fromEndpoint = buildAssociationEndpointWithIndex(index, fromNode.id);
    const toEndpoint = buildAssociationEndpointWithIndex(index, toNode.id);
    if (!fromEndpoint || !toEndpoint) {
      changed = true;
      continue;
    }

    const normalized: MindMapAssociation = {
      id: association.id,
      from: fromEndpoint,
      to: toEndpoint,
    };

    if (!associationEquals(association, normalized)) {
      changed = true;
    }
    next.push(normalized);
  }

  const deduped = dedupeAssociations(next);
  if (deduped.length !== next.length) {
    changed = true;
  }

  return {
    associations: deduped,
    changed,
  };
}

export function cloneAssociations(
  associations: MindMapAssociation[],
): MindMapAssociation[] {
  return associations.map((association) => ({
    id: association.id,
    from: {
      nodeId: association.from.nodeId,
      locator: cloneLocator(association.from.locator),
    },
    to: {
      nodeId: association.to.nodeId,
      locator: cloneLocator(association.to.locator),
    },
  }));
}

export function associationsEqual(
  left: MindMapAssociation[],
  right: MindMapAssociation[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftAssociation = left[index];
    const rightAssociation = right[index];
    if (!leftAssociation || !rightAssociation || !associationEquals(leftAssociation, rightAssociation)) {
      return false;
    }
  }

  return true;
}

export function createAssociationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `assoc:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function buildAssociationEndpointWithIndex(
  index: DocumentIndex,
  nodeId: string,
): MindMapAssociationEndpoint | null {
  const context = index.byNodeId.get(nodeId);
  if (!context || context.node.source.kind === "virtual-root") {
    return null;
  }

  return {
    nodeId: context.node.id,
    locator: {
      kind: context.node.source.kind,
      text: context.node.text,
      depth: context.node.source.depth,
      ancestorTexts: [...context.ancestorTexts],
      siblingIndex: context.siblingIndex,
      subtreeSignature: context.subtreeSignature,
    },
  };
}

function resolveAssociationEndpointWithIndex(
  index: DocumentIndex,
  endpoint: MindMapAssociationEndpoint,
): MindMapNode | null {
  const directContext = index.byNodeId.get(endpoint.nodeId);
  if (
    directContext &&
    directContext.node.source.kind === endpoint.locator.kind &&
    directContext.node.text === endpoint.locator.text
  ) {
    return directContext.node;
  }

  const candidates =
    index.candidatesByKey.get(
      `${endpoint.locator.kind}:${normalizeKey(endpoint.locator.text)}`,
    ) ?? [];
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0]?.node ?? null;
  }

  const strict = candidates.filter(
    (candidate) =>
      candidate.node.source.depth === endpoint.locator.depth &&
      candidate.siblingIndex === endpoint.locator.siblingIndex &&
      arrayEquals(candidate.ancestorTexts, endpoint.locator.ancestorTexts),
  );
  if (strict.length === 1) {
    return strict[0]?.node ?? null;
  }

  const sameSignature = candidates.filter(
    (candidate) => candidate.subtreeSignature === endpoint.locator.subtreeSignature,
  );
  if (sameSignature.length === 1) {
    return sameSignature[0]?.node ?? null;
  }

  let best: NodeContext | null = null;
  let bestScore = -1;
  let tied = false;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, endpoint.locator);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      tied = false;
      continue;
    }

    if (score === bestScore) {
      tied = true;
    }
  }

  if (!best || tied || bestScore < 30) {
    if (
      directContext &&
      directContext.node.source.kind === endpoint.locator.kind &&
      directContext.siblingIndex === endpoint.locator.siblingIndex &&
      arrayEquals(directContext.ancestorTexts, endpoint.locator.ancestorTexts)
    ) {
      return directContext.node;
    }

    return null;
  }

  return best.node;
}

function scoreCandidate(candidate: NodeContext, locator: MindMapNodeLocator): number {
  let score = 0;

  if (candidate.node.source.depth === locator.depth) {
    score += 20;
  }

  if (candidate.siblingIndex === locator.siblingIndex) {
    score += 10;
  }

  if (arrayEquals(candidate.ancestorTexts, locator.ancestorTexts)) {
    score += 120;
  } else {
    const sharedDepth = countSharedPrefix(candidate.ancestorTexts, locator.ancestorTexts);
    score += sharedDepth * 12;

    const candidateParent = candidate.ancestorTexts[candidate.ancestorTexts.length - 1];
    const locatorParent = locator.ancestorTexts[locator.ancestorTexts.length - 1];
    if (candidateParent && locatorParent && candidateParent === locatorParent) {
      score += 20;
    }
  }

  if (candidate.subtreeSignature === locator.subtreeSignature) {
    score += 50;
  }

  return score;
}

function buildDocumentIndex(document: MindMapDocument): DocumentIndex {
  const byNodeId = new Map<string, NodeContext>();
  const candidatesByKey = new Map<string, NodeContext[]>();

  const visit = (
    node: MindMapNode,
    parentId: string | null,
    ancestorTexts: string[],
    siblingIndex: number,
  ): string => {
    const childAncestorTexts =
      node.source.kind === "virtual-root" ? ancestorTexts : [...ancestorTexts, node.text];
    const structuralChildren = node.children.filter((child) => child.source.kind !== "virtual-root");
    const childCounts = new Map<string, number>();
    const childSignatures: string[] = [];

    for (const child of structuralChildren) {
      const siblingKey = `${child.source.kind}:${normalizeKey(child.text)}`;
      const nextSiblingIndex = childCounts.get(siblingKey) ?? 0;
      childCounts.set(siblingKey, nextSiblingIndex + 1);
      childSignatures.push(visit(child, node.id, childAncestorTexts, nextSiblingIndex));
    }

    const selfSignature = [
      node.source.kind,
      normalizeKey(node.text),
      childSignatures.join("|"),
    ].join(":");

    if (node.source.kind !== "virtual-root") {
      const context: NodeContext = {
        node,
        parentId,
        ancestorTexts: [...ancestorTexts],
        siblingIndex,
        subtreeSignature: selfSignature,
      };

      byNodeId.set(node.id, context);
      const lookupKey = `${node.source.kind}:${normalizeKey(node.text)}`;
      const candidates = candidatesByKey.get(lookupKey) ?? [];
      candidates.push(context);
      candidatesByKey.set(lookupKey, candidates);
    }

    return selfSignature;
  };

  visit(document.root, null, [], 0);

  return {
    byNodeId,
    candidatesByKey,
  };
}

function dedupeAssociations(associations: MindMapAssociation[]): MindMapAssociation[] {
  const seen = new Set<string>();
  const next: MindMapAssociation[] = [];

  for (const association of associations) {
    const endpoints = [association.from.nodeId, association.to.nodeId].sort();
    const key = `${endpoints[0]}::${endpoints[1]}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(association);
  }

  return next;
}

function cloneLocator(locator: MindMapNodeLocator): MindMapNodeLocator {
  return {
    kind: locator.kind,
    text: locator.text,
    depth: locator.depth,
    ancestorTexts: [...locator.ancestorTexts],
    siblingIndex: locator.siblingIndex,
    subtreeSignature: locator.subtreeSignature,
  };
}

function associationEquals(left: MindMapAssociation, right: MindMapAssociation): boolean {
  return (
    left.id === right.id &&
    endpointEquals(left.from, right.from) &&
    endpointEquals(left.to, right.to)
  );
}

function endpointEquals(
  left: MindMapAssociationEndpoint,
  right: MindMapAssociationEndpoint,
): boolean {
  return left.nodeId === right.nodeId && locatorEquals(left.locator, right.locator);
}

function locatorEquals(left: MindMapNodeLocator, right: MindMapNodeLocator): boolean {
  return (
    left.kind === right.kind &&
    left.text === right.text &&
    left.depth === right.depth &&
    left.siblingIndex === right.siblingIndex &&
    left.subtreeSignature === right.subtreeSignature &&
    arrayEquals(left.ancestorTexts, right.ancestorTexts)
  );
}

function normalizeKey(value: string): string {
  return value.trim();
}

function arrayEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function countSharedPrefix(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;

  while (count < limit && left[count] === right[count]) {
    count += 1;
  }

  return count;
}
