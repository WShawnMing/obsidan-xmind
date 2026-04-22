export type NodeKind =
  | "virtual-root"
  | "heading"
  | "overflow-list"
  | "linked-note"
  | "image-embed";
export type MindMapBackgroundStyle = "plain" | "grid" | "dots" | "aurora";
export type MindMapNodeShape = "pill" | "rounded" | "soft-square";
export type MindMapConnectionStyle = "curved" | "angled" | "straight";
export type MindMapAssociationEndpointKind = Exclude<NodeKind, "virtual-root">;

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
  kind: "heading" | "overflow-list" | "linked-note" | "image-embed";
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

export interface MindMapImageEmbed {
  raw: string;
  alt: string;
  target: string;
  title?: string;
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
  image?: MindMapImageEmbed;
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

export interface AppearanceSettings {
  backgroundStyle: MindMapBackgroundStyle;
  nodeShape: MindMapNodeShape;
  connectionStyle: MindMapConnectionStyle;
}

export interface PluginData {
  layoutByFile?: Record<string, Record<string, NodeLayoutOffset>>;
  associationsByFile?: Record<string, MindMapAssociation[]>;
  appearance?: Partial<AppearanceSettings>;
}

export interface MindMapNodeLocator {
  kind: MindMapAssociationEndpointKind;
  text: string;
  depth: number;
  ancestorTexts: string[];
  siblingIndex: number;
  subtreeSignature: string;
}

export interface MindMapAssociationEndpoint {
  nodeId: string;
  locator: MindMapNodeLocator;
}

export interface MindMapAssociation {
  id: string;
  from: MindMapAssociationEndpoint;
  to: MindMapAssociationEndpoint;
  label?: string;
  labelOffset?: NodeLayoutOffset;
}
