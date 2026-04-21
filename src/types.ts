export type NodeKind = "virtual-root" | "heading" | "overflow-list" | "linked-note";

export interface SourceDocumentRef {
  path: string;
  basename: string;
}

export interface NodeSourceSpan {
  from: number;
  to: number;
  line: number;
  column: number;
  depth: number;
  kind: "heading" | "overflow-list";
}

export interface MindMapNodeSource {
  kind: NodeKind;
  depth: number;
  span?: NodeSourceSpan;
}

export interface MindMapWikiLink {
  raw: string;
  text: string;
  target: string;
  alias?: string;
  subpath?: string;
  exists?: boolean;
}

export type MindMapInlineToken =
  | {
      type: "text";
      raw: string;
      text: string;
    }
  | ({
      type: "wikilink";
    } & MindMapWikiLink);

export interface MindMapNode {
  id: string;
  text: string;
  label: string;
  tokens: MindMapInlineToken[];
  links: MindMapWikiLink[];
  children: MindMapNode[];
  collapsed: boolean;
  source: MindMapNodeSource;
}

export interface MindMapDocument {
  root: MindMapNode;
  nodesById: Map<string, MindMapNode>;
  warnings: string[];
}

export interface MindMapViewState extends Record<string, unknown> {
  filePath?: string;
}

export interface PositionedMindMapNode {
  node: MindMapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

export interface MindMapEdge {
  parentId: string;
  childId: string;
  path: string;
}

export interface MindMapLayout {
  nodes: Map<string, PositionedMindMapNode>;
  edges: MindMapEdge[];
  bounds: {
    width: number;
    height: number;
  };
}

export interface NodeLayoutOffset {
  x: number;
  y: number;
}

export interface PluginData {
  layoutByFile?: Record<string, Record<string, NodeLayoutOffset>>;
}
