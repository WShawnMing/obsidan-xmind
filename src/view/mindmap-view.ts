import {
  ItemView,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
  getLinkpath,
} from "obsidian";
import {
  DEFAULT_VIEWPORT,
  FOLD_BADGE_OFFSET,
  FOLD_BADGE_SIZE,
  MAX_SCALE,
  MIN_SCALE,
  VIEW_NAME,
  VIEW_TYPE,
} from "../constants";
import { layoutMindMap } from "../layout/tree-layout";
import { parseMarkdownToMindMap } from "../parser/markdown-parser";
import type {
  MindMapDocument,
  MindMapInlineToken,
  MindMapLayout,
  MindMapNode,
  MindMapViewState,
  NodeLayoutOffset,
  PositionedMindMapNode,
} from "../types";
import {
  StructurePatchError,
  type InsertedNodeSelection,
  deleteNode,
  insertChildNode,
  insertSiblingNode,
  moveNode,
  type MoveNodePosition,
} from "../write/structure-patch-writer";
import { TitlePatchError, patchNodeTitle } from "../write/title-patch-writer";
import type ObsidianXMindPlugin from "../main";

const SVG_NS = "http://www.w3.org/2000/svg";

interface ViewElements {
  toolbarTitle: HTMLElement;
  surface: HTMLElement;
  stage: HTMLElement;
  svg: SVGSVGElement;
  nodes: HTMLElement;
  undoBar: HTMLElement;
  undoMessage: HTMLElement;
  undoAction: HTMLButtonElement;
  undoDismiss: HTMLButtonElement;
}

interface PendingSelectionState {
  source:
    | {
        type: "inserted";
        selection: InsertedNodeSelection;
        startEditing: boolean;
      }
    | {
        type: "node-id";
        nodeId: string;
      };
}

interface UndoHistoryEntry {
  filePath: string;
  label: string;
  beforeContent: string;
  afterContent: string;
  beforeLayout: Record<string, NodeLayoutOffset>;
  afterLayout: Record<string, NodeLayoutOffset>;
  restoreSelectionNodeId: string | null;
}

interface NodeDragState {
  pointerId: number;
  anchorNodeId: string;
  subtreeNodeIds: string[];
  startClientX: number;
  startClientY: number;
  startAnchorX: number;
  startAnchorY: number;
  beforeLayout: Record<string, NodeLayoutOffset>;
  initialOffsets: Record<string, NodeLayoutOffset>;
  didDrag: boolean;
}

interface DropPreviewState {
  targetNodeId: string;
  position: MoveNodePosition;
}

export class MindMapView extends ItemView {
  private plugin: ObsidianXMindPlugin;
  private file: TFile | null = null;
  private parsed: MindMapDocument | null = null;
  private elements: ViewElements | null = null;
  private selectedNodeId: string | null = null;
  private editingNodeId: string | null = null;
  private editorInput: HTMLInputElement | null = null;
  private pendingSelection: PendingSelectionState | null = null;
  private undoHistory: UndoHistoryEntry[] = [];
  private undoBarDismissed = false;
  private nodeLayoutOffsets: Record<string, NodeLayoutOffset> = {};
  private lastRenderedLayout: MindMapLayout | null = null;
  private nodeDragState: NodeDragState | null = null;
  private dropPreview: DropPreviewState | null = null;
  private suppressNextNodeClick = false;
  private isCommittingEdit = false;
  private isApplyingLocalChange = false;
  private isUndoing = false;
  private viewport = { ...DEFAULT_VIEWPORT };
  private panState:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
      }
    | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianXMindPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return VIEW_NAME;
  }

  getIcon(): string {
    return "git-branch";
  }

  getState(): MindMapViewState {
    return this.file ? { filePath: this.file.path } : {};
  }

  async setState(state: MindMapViewState): Promise<void> {
    const maybeFile = state.filePath
      ? this.app.vault.getAbstractFileByPath(state.filePath)
      : null;
    this.file = maybeFile instanceof TFile ? maybeFile : null;
    await this.refresh();
  }

  async onOpen(): Promise<void> {
    this.buildUi();
    this.render();
  }

  async onClose(): Promise<void> {
    this.endEditing(false);
  }

  isDisplayingFile(filePath: string): boolean {
    return this.file?.path === filePath;
  }

  getCurrentFilePath(): string | null {
    return this.file?.path ?? null;
  }

  async handleFileModified(file: TFile): Promise<void> {
    if (!this.file || this.file.path !== file.path) {
      return;
    }

    this.file = file;
    await this.refresh();
  }

  async handleFileRenamed(file: TFile, oldPath: string): Promise<void> {
    if (!this.file || (this.file.path !== oldPath && this.file.path !== file.path)) {
      return;
    }

    this.file = file;
    await this.refresh();
  }

  async handleAppearanceChanged(): Promise<void> {
    this.applyAppearanceAttributes();
    this.render();
  }

  async refresh(): Promise<void> {
    if (!this.file) {
      this.parsed = null;
      this.selectedNodeId = null;
      this.undoHistory = [];
      this.undoBarDismissed = false;
      this.nodeLayoutOffsets = {};
      this.lastRenderedLayout = null;
      this.nodeDragState = null;
      this.dropPreview = null;
      this.endEditing(false);
      this.render();
      this.renderUndoBar();
      return;
    }

    const previousCollapsedIds = new Set<string>();
    if (this.parsed) {
      for (const node of this.parsed.nodesById.values()) {
        if (node.collapsed) {
          previousCollapsedIds.add(node.id);
        }
      }
    }

    const content = await this.app.vault.read(this.file);
    const parsed = parseMarkdownToMindMap(
      {
        path: this.file.path,
        basename: this.file.basename,
      },
      content,
    );

    for (const node of parsed.nodesById.values()) {
      if (previousCollapsedIds.has(node.id)) {
        node.collapsed = true;
      }
    }

    this.nodeLayoutOffsets = this.plugin.getLayoutForFile(this.file.path);
    const validNodeIds = new Set(parsed.nodesById.keys());
    let pruned = false;
    for (const nodeId of Object.keys(this.nodeLayoutOffsets)) {
      if (!validNodeIds.has(nodeId)) {
        delete this.nodeLayoutOffsets[nodeId];
        pruned = true;
      }
    }
    if (pruned) {
      void this.plugin.setLayoutForFile(this.file.path, this.nodeLayoutOffsets);
    }

    const latestUndo = this.undoHistory[this.undoHistory.length - 1];
    if (
      !this.isApplyingLocalChange &&
      latestUndo &&
      (latestUndo.filePath !== this.file.path ||
        latestUndo.afterContent !== content ||
        !layoutOffsetsEqual(latestUndo.afterLayout, this.nodeLayoutOffsets))
    ) {
      this.undoHistory = [];
      this.undoBarDismissed = false;
    }

    this.parsed = parsed;
    this.endEditing(false);
    if (this.pendingSelection) {
      this.applyPendingSelection(parsed);
    }
    if (!this.selectedNodeId || !parsed.nodesById.has(this.selectedNodeId)) {
      this.selectedNodeId = parsed.root.id;
    }
    this.render();
    this.renderUndoBar();
  }

  async editSelectedNode(): Promise<void> {
    if (!this.selectedNodeId) {
      return;
    }
    this.startEditing(this.selectedNodeId);
  }

  canUndoLastAction(): boolean {
    return (
      !!this.file &&
      !this.editingNodeId &&
      !this.isCommittingEdit &&
      this.undoHistory.length > 0
    );
  }

  async undoLastAction(): Promise<void> {
    if (!this.file) {
      return;
    }

    const entry = this.undoHistory[this.undoHistory.length - 1];
    if (!entry) {
      return;
    }

    if (entry.filePath !== this.file.path) {
      this.undoHistory = [];
      this.undoBarDismissed = false;
      this.renderUndoBar();
      return;
    }

    try {
      const currentContent = await this.app.vault.read(this.file);
      const currentLayout = this.plugin.getLayoutForFile(this.file.path);
      if (
        currentContent !== entry.afterContent ||
        !layoutOffsetsEqual(currentLayout, entry.afterLayout)
      ) {
        this.undoHistory = [];
        this.undoBarDismissed = false;
        this.renderUndoBar();
        new Notice("Undo is no longer available because the mind map changed.");
        return;
      }

      this.isUndoing = true;
      this.pendingSelection = entry.restoreSelectionNodeId
        ? {
            source: {
              type: "node-id",
              nodeId: entry.restoreSelectionNodeId,
            },
          }
        : null;
      this.undoHistory.pop();
      this.undoBarDismissed = false;
      this.nodeLayoutOffsets = cloneLayoutOffsets(entry.beforeLayout);
      await this.plugin.setLayoutForFile(this.file.path, entry.beforeLayout);
      await this.app.vault.modify(this.file, entry.beforeContent);
      await this.refresh();
    } catch {
      new Notice("Failed to undo the last mind map change.");
    } finally {
      this.isUndoing = false;
    }
  }

  async addSiblingNode(): Promise<void> {
    if (!this.file || !this.parsed || !this.selectedNodeId) {
      return;
    }

    const node = this.parsed.nodesById.get(this.selectedNodeId);
    if (!node) {
      return;
    }

    if (this.parsed.root.id === node.id) {
      new Notice("The root topic only supports child topics.");
      return;
    }

    await this.applyStructureEdit(insertSiblingNode, node);
  }

  async addChildNode(): Promise<void> {
    if (!this.file || !this.parsed || !this.selectedNodeId) {
      return;
    }

    const node = this.parsed.nodesById.get(this.selectedNodeId);
    if (!node) {
      return;
    }

    await this.applyStructureEdit(insertChildNode, node);
  }

  async deleteSelectedNode(): Promise<void> {
    if (!this.file || !this.parsed || !this.selectedNodeId) {
      return;
    }

    const node = this.parsed.nodesById.get(this.selectedNodeId);
    if (!node) {
      return;
    }

    const parent = findParentNode(this.parsed.root, node.id);
    const descendantCount = countDescendants(node);

    if (node.children.length > 0) {
      const confirmed = await confirmDeleteWithChildren(this, node, descendantCount);
      if (!confirmed) {
        return;
      }
    }

    this.isApplyingLocalChange = true;

    try {
      const content = await this.app.vault.read(this.file);
      const nextContent = deleteNode(content, this.parsed, node);
      this.pendingSelection = parent
        ? {
            source: {
              type: "node-id",
              nodeId: parent.id,
            },
          }
        : null;
      if (nextContent !== content) {
        const beforeLayout = cloneLayoutOffsets(this.nodeLayoutOffsets);
        await this.app.vault.modify(this.file, nextContent);
        this.nodeLayoutOffsets = {};
        await this.plugin.setLayoutForFile(this.file.path, {});
        this.pushUndoEntry({
          filePath: this.file.path,
          label: `Deleted “${node.label || node.text}”`,
          beforeContent: content,
          afterContent: nextContent,
          beforeLayout,
          afterLayout: {},
          restoreSelectionNodeId: node.id,
        });
      }
      await this.refresh();
    } catch (error) {
      if (error instanceof StructurePatchError) {
        new Notice(error.message);
        if (error.code === "STALE_SOURCE") {
          await this.refresh();
        }
        return;
      }

      new Notice("Failed to delete the selected topic.");
    } finally {
      this.isApplyingLocalChange = false;
    }
  }

  private buildUi(): void {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("oxm-view");
    this.contentEl.tabIndex = 0;

    const toolbar = document.createElement("div");
    toolbar.className = "oxm-toolbar";

    const toolbarMeta = document.createElement("div");
    toolbarMeta.className = "oxm-toolbar-meta";
    const toolbarTitle = document.createElement("div");
    toolbarTitle.className = "oxm-toolbar-title";
    toolbarMeta.append(toolbarTitle);
    toolbar.append(toolbarMeta);

    const surface = document.createElement("div");
    surface.className = "oxm-surface";

    const stage = document.createElement("div");
    stage.className = "oxm-stage";

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("oxm-lines");
    svg.setAttribute("aria-hidden", "true");
    stage.append(svg);

    const nodes = document.createElement("div");
    nodes.className = "oxm-nodes";
    stage.append(nodes);
    surface.append(stage);

    const undoBar = document.createElement("div");
    undoBar.className = "oxm-undo-bar";
    undoBar.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    const undoMessage = document.createElement("div");
    undoMessage.className = "oxm-undo-message";

    const undoActions = document.createElement("div");
    undoActions.className = "oxm-undo-actions";

    const undoAction = document.createElement("button");
    undoAction.className = "oxm-undo-button";
    undoAction.type = "button";
    undoAction.textContent = "Undo";
    undoAction.addEventListener("click", () => {
      void this.undoLastAction();
    });

    const undoDismiss = document.createElement("button");
    undoDismiss.className = "oxm-undo-dismiss";
    undoDismiss.type = "button";
    undoDismiss.setAttribute("aria-label", "Dismiss undo banner");
    undoDismiss.textContent = "×";
    undoDismiss.addEventListener("click", () => {
      this.undoBarDismissed = true;
      this.renderUndoBar();
    });

    undoActions.append(undoAction, undoDismiss);
    undoBar.append(undoMessage, undoActions);

    surface.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    surface.addEventListener("pointermove", (event) => this.onPointerMove(event));
    surface.addEventListener("pointerup", (event) => this.onPointerUp(event));
    surface.addEventListener("pointercancel", (event) => this.onPointerUp(event));
    surface.addEventListener(
      "wheel",
      (event) => this.onWheel(event),
      { passive: false },
    );
    this.contentEl.addEventListener("keydown", (event) => this.onKeyDown(event));

    this.contentEl.append(toolbar, surface, undoBar);
    this.elements = {
      toolbarTitle,
      surface,
      stage,
      svg,
      nodes,
      undoBar,
      undoMessage,
      undoAction,
      undoDismiss,
    };
    this.applyAppearanceAttributes();
    this.applyViewport();
    this.renderUndoBar();
  }

  private render(): void {
    if (!this.elements) {
      return;
    }

    const { toolbarTitle, stage, svg, nodes } =
      this.elements;

    toolbarTitle.textContent = this.file ? this.file.basename : "No Markdown note selected";

    svg.replaceChildren();
    nodes.replaceChildren();

    if (!this.file || !this.parsed) {
      this.lastRenderedLayout = null;
      stage.style.width = "0px";
      stage.style.height = "0px";
      return;
    }

    const layout = layoutMindMap(
      this.parsed.root,
      this.nodeLayoutOffsets,
      this.plugin.getAppearanceSettings().connectionStyle,
    );
    this.lastRenderedLayout = layout;
    stage.style.width = `${layout.bounds.width}px`;
    stage.style.height = `${layout.bounds.height}px`;
    svg.setAttribute("width", `${layout.bounds.width}`);
    svg.setAttribute("height", `${layout.bounds.height}`);
    svg.setAttribute("viewBox", `0 0 ${layout.bounds.width} ${layout.bounds.height}`);

    for (const edge of layout.edges) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edge.path);
      path.classList.add("oxm-line");
      svg.append(path);
    }

    const dropPreviewElements = this.renderDropPreview(layout);
    if (dropPreviewElements) {
      svg.append(...dropPreviewElements.svg);
    }

    for (const positioned of layout.nodes.values()) {
      const elements = this.renderNode(positioned);
      nodes.append(...elements);
    }

    if (dropPreviewElements) {
      nodes.append(...dropPreviewElements.html);
    }
  }

  private renderNode(positioned: PositionedMindMapNode): HTMLElement[] {
    const node = positioned.node;
    const editable =
      node.source.kind === "heading" || node.source.kind === "overflow-list";
    const nodeEl = document.createElement("div");
    nodeEl.className = "oxm-node";
    nodeEl.style.left = `${positioned.x}px`;
    nodeEl.style.top = `${positioned.y}px`;
    nodeEl.style.width = `${positioned.width}px`;
    nodeEl.style.height = `${positioned.height}px`;

    const isEditing = this.editingNodeId === node.id;

    if (node.id === this.selectedNodeId && !isEditing) {
      nodeEl.classList.add("is-selected");
    }

    if (positioned.depth === 0) {
      nodeEl.classList.add("is-root");
    }

    if (node.source.kind === "linked-note") {
      nodeEl.classList.add("is-linked-note");
    }

    if (!editable) {
      nodeEl.classList.add("is-readonly");
    }

    if (isEditing) {
      nodeEl.classList.add("is-editing");
    }

    if (this.nodeDragState?.anchorNodeId === node.id && this.nodeDragState.didDrag) {
      nodeEl.classList.add("is-dragging");
    }

    if (this.dropPreview?.targetNodeId === node.id) {
      nodeEl.classList.add("is-drop-target");
      nodeEl.classList.add(
        this.dropPreview.position === "child" ? "is-drop-child" : "is-drop-sibling",
      );
    }

    const contentEl = document.createElement("div");
    contentEl.className = "oxm-node-content";

    if (isEditing && editable) {
      const input = document.createElement("input");
      input.className = "oxm-node-input";
      input.type = "text";
      input.value = node.text;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          void this.commitEditing();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.endEditing(true);
          this.render();
        }
      });
      input.addEventListener("blur", () => {
        void this.commitEditing();
      });
      contentEl.append(input);
      this.editorInput = input;
      window.requestAnimationFrame(() => {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      });
    } else {
      for (const token of node.tokens) {
        contentEl.append(this.renderToken(token));
      }
    }

    nodeEl.append(contentEl);
    nodeEl.addEventListener("pointerdown", (event) => {
      this.onNodePointerDown(event, node.id);
    });
    nodeEl.addEventListener("click", (event) => {
      if (this.suppressNextNodeClick) {
        this.suppressNextNodeClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        void this.jumpToNodeSource(node);
        return;
      }
      if ((event.target as HTMLElement).closest(".oxm-token-link")) {
        return;
      }
      if (this.editingNodeId === node.id) {
        return;
      }

      if (this.selectedNodeId === node.id && editable) {
        this.startEditing(node.id);
        return;
      }

      this.selectedNodeId = node.id;
      this.contentEl.focus();
      this.render();
    });
    nodeEl.addEventListener("dblclick", () => {
      this.startEditing(node.id);
    });
    nodeEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.jumpToNodeSource(node);
    });

    const elements: HTMLElement[] = [nodeEl];
    if (node.children.length > 0) {
      const toggle = this.renderFoldBadge(positioned);
      elements.push(toggle);
    }

    return elements;
  }

  private renderToken(token: MindMapInlineToken): HTMLElement {
    if (token.type === "text") {
      const span = document.createElement("span");
      span.className = "oxm-token-text";
      span.textContent = token.text;
      return span;
    }

    const button = document.createElement("button");
    button.className = "oxm-token-link";
    button.type = "button";
    button.textContent = token.text;

    const sourcePath = this.file?.path;
    const linkText = token.raw.slice(2, -2);
    const destination =
      sourcePath != null
        ? this.app.metadataCache.getFirstLinkpathDest(getLinkpath(linkText), sourcePath)
        : null;

    if (!destination) {
      button.classList.add("is-missing");
    }

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!sourcePath) {
        return;
      }
      void this.app.workspace.openLinkText(linkText, sourcePath);
    });

    return button;
  }

  private startEditing(nodeId: string): void {
    if (!this.parsed) {
      return;
    }

    const node = this.parsed.nodesById.get(nodeId);
    if (
      !node ||
      (node.source.kind !== "heading" && node.source.kind !== "overflow-list")
    ) {
      return;
    }

    this.selectedNodeId = nodeId;
    this.editingNodeId = nodeId;
    this.render();
  }

  private renderFoldBadge(positioned: PositionedMindMapNode): HTMLButtonElement {
    const node = positioned.node;
    const button = document.createElement("button");
    button.className = "oxm-fold-badge";
    button.type = "button";
    button.style.left = `${positioned.x + positioned.width + FOLD_BADGE_OFFSET - FOLD_BADGE_SIZE / 2}px`;
    button.style.top = `${positioned.y + positioned.height / 2 - FOLD_BADGE_SIZE / 2}px`;

    if (node.collapsed) {
      button.classList.add("is-collapsed");
      const hiddenCount = countDescendants(node);
      button.textContent = `${hiddenCount}`;
      button.title = `Expand ${hiddenCount} hidden nodes`;
    } else {
      button.textContent = "−";
      button.title = "Collapse branch";
    }

    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      node.collapsed = !node.collapsed;
      this.render();
    });

    return button;
  }

  private renderDropPreview(
    layout: MindMapLayout,
  ): { svg: SVGElement[]; html: HTMLElement[] } | null {
    if (!this.dropPreview || !this.nodeDragState) {
      return null;
    }

    const target = layout.nodes.get(this.dropPreview.targetNodeId);
    const dragged = layout.nodes.get(this.nodeDragState.anchorNodeId);
    if (!target || !dragged) {
      return null;
    }

    const svgElements: SVGElement[] = [];
    const htmlElements: HTMLElement[] = [];

    if (this.dropPreview.position === "child") {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute(
        "d",
        buildPreviewCurve(
          target.x + target.width,
          target.y + target.height / 2,
          dragged.x,
          dragged.y + dragged.height / 2,
        ),
      );
      path.classList.add("oxm-preview-line");
      svgElements.push(path);
      return { svg: svgElements, html: htmlElements };
    }

    const indicatorY =
      this.dropPreview.position === "before"
        ? target.y - 10
        : target.y + target.height + 8;
    const indicatorStartX = target.x - 18;
    const indicatorEndX = indicatorStartX + Math.min(96, target.width + 24);

    const connector = document.createElementNS(SVG_NS, "path");
    connector.setAttribute(
      "d",
      buildPreviewCurve(
        dragged.x + dragged.width,
        dragged.y + dragged.height / 2,
        indicatorStartX,
        indicatorY,
      ),
    );
    connector.classList.add("oxm-preview-line");
    svgElements.push(connector);

    const indicator = document.createElement("div");
    indicator.className = "oxm-drop-indicator";
    indicator.style.left = `${indicatorStartX}px`;
    indicator.style.width = `${indicatorEndX - indicatorStartX}px`;
    indicator.style.top = `${indicatorY}px`;

    const dot = document.createElement("div");
    dot.className = "oxm-drop-indicator-dot";
    indicator.append(dot);
    htmlElements.push(indicator);

    return { svg: svgElements, html: htmlElements };
  }

  private onNodePointerDown(event: PointerEvent, nodeId: string): void {
    if (
      event.button !== 0 ||
      this.editingNodeId ||
      (event.target as HTMLElement).closest(".oxm-token-link, .oxm-fold-badge")
    ) {
      return;
    }

    if (!this.parsed || !this.lastRenderedLayout) {
      return;
    }

    const positioned = this.lastRenderedLayout.nodes.get(nodeId);
    if (!positioned) {
      return;
    }

    const subtreeNodeIds = collectSubtreeNodeIds(positioned.node);
    const initialOffsets: Record<string, NodeLayoutOffset> = {};
    for (const subtreeNodeId of subtreeNodeIds) {
      initialOffsets[subtreeNodeId] = this.nodeLayoutOffsets[subtreeNodeId] ?? { x: 0, y: 0 };
    }

    this.nodeDragState = {
      pointerId: event.pointerId,
      anchorNodeId: nodeId,
      subtreeNodeIds,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startAnchorX: positioned.x,
      startAnchorY: positioned.y,
      beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      initialOffsets,
      didDrag: false,
    };
    this.elements?.surface.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }

  private async commitEditing(): Promise<void> {
    if (!this.file || !this.parsed || !this.editingNodeId || !this.editorInput) {
      return;
    }

    if (this.isCommittingEdit) {
      return;
    }

    this.isCommittingEdit = true;
    this.isApplyingLocalChange = true;
    const nextTitle = this.editorInput.value;
    const node = this.parsed.nodesById.get(this.editingNodeId);

    try {
      if (!node) {
        this.endEditing(false);
        this.render();
        return;
      }

      const content = await this.app.vault.read(this.file);
      const nextContent = patchNodeTitle(content, node, nextTitle);
      this.endEditing(false);
      if (nextContent !== content) {
        await this.app.vault.modify(this.file, nextContent);
        this.pushUndoEntry({
          filePath: this.file.path,
          label: `Renamed “${node.label || node.text}”`,
          beforeContent: content,
          afterContent: nextContent,
          beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
          afterLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
          restoreSelectionNodeId: node.id,
        });
      }
      await this.refresh();
    } catch (error) {
      this.endEditing(false);
      if (error instanceof TitlePatchError) {
        if (error.code === "STALE_SOURCE") {
          new Notice("The note changed. Refreshing the mind map before retry.");
          await this.refresh();
        } else {
          new Notice(error.message);
          this.render();
        }
      } else {
        new Notice("Failed to update the note title.");
        this.render();
      }
    } finally {
      this.isApplyingLocalChange = false;
      this.isCommittingEdit = false;
    }
  }

  private endEditing(restoreSelection: boolean): void {
    if (restoreSelection && this.editingNodeId) {
      this.selectedNodeId = this.editingNodeId;
    }
    this.editingNodeId = null;
    this.editorInput = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.editingNodeId) {
      return;
    }

    if ((event.metaKey || event.ctrlKey || event.altKey) && event.key !== "Backspace") {
      return;
    }

    if (!this.selectedNodeId) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void this.addSiblingNode();
      return;
    }

    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      void this.addChildNode();
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      void this.deleteSelectedNode();
      return;
    }

    if (event.key === "F2") {
      event.preventDefault();
      this.startEditing(this.selectedNodeId);
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest(".oxm-node, .oxm-fold-badge")) {
      return;
    }

    this.panState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: this.viewport.x,
      originY: this.viewport.y,
    };
    this.elements?.surface.classList.add("is-panning");
    this.elements?.surface.setPointerCapture(event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.nodeDragState && event.pointerId === this.nodeDragState.pointerId) {
      const scale = this.viewport.scale || 1;
      const rawDeltaX = (event.clientX - this.nodeDragState.startClientX) / scale;
      const rawDeltaY = (event.clientY - this.nodeDragState.startClientY) / scale;
      const deltaX = Math.max(16 - this.nodeDragState.startAnchorX, rawDeltaX);
      const deltaY = Math.max(8 - this.nodeDragState.startAnchorY, rawDeltaY);

      if (
        !this.nodeDragState.didDrag &&
        Math.hypot(deltaX, deltaY) < 4
      ) {
        return;
      }

      this.nodeDragState.didDrag = true;
      this.selectedNodeId = this.nodeDragState.anchorNodeId;

      for (const nodeId of this.nodeDragState.subtreeNodeIds) {
        const base = this.nodeDragState.initialOffsets[nodeId] ?? { x: 0, y: 0 };
        this.nodeLayoutOffsets[nodeId] = {
          x: base.x + deltaX,
          y: base.y + deltaY,
        };
      }

      this.dropPreview = this.computeDropPreview(event);
      this.render();
      this.renderUndoBar();
      return;
    }

    if (!this.panState || event.pointerId !== this.panState.pointerId) {
      return;
    }

    this.viewport.x = this.panState.originX + (event.clientX - this.panState.startX);
    this.viewport.y = this.panState.originY + (event.clientY - this.panState.startY);
    this.applyViewport();
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.nodeDragState && event.pointerId === this.nodeDragState.pointerId) {
      const didDrag = this.nodeDragState.didDrag;
      const dropPreview = this.dropPreview;
      const anchorNodeId = this.nodeDragState.anchorNodeId;
      const beforeLayout = cloneLayoutOffsets(this.nodeDragState.beforeLayout);
      this.nodeDragState = null;
      this.dropPreview = null;
      if (this.elements?.surface.hasPointerCapture(event.pointerId)) {
        this.elements.surface.releasePointerCapture(event.pointerId);
      }

      if (didDrag) {
        this.suppressNextNodeClick = true;
        if (dropPreview) {
          void this.applyDragMove(anchorNodeId, dropPreview, beforeLayout);
        } else if (this.file) {
          void this.persistLayoutDrag(anchorNodeId, beforeLayout);
        }
      }
      return;
    }

    if (!this.panState || event.pointerId !== this.panState.pointerId) {
      return;
    }

    this.panState = null;
    this.elements?.surface.classList.remove("is-panning");
    this.elements?.surface.releasePointerCapture(event.pointerId);
  }

  private onWheel(event: WheelEvent): void {
    if (!this.elements) {
      return;
    }

    event.preventDefault();
    const nextScale = clamp(
      this.viewport.scale * (event.deltaY > 0 ? 0.92 : 1.08),
      MIN_SCALE,
      MAX_SCALE,
    );

    const rect = this.elements.surface.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const worldX = (anchorX - this.viewport.x) / this.viewport.scale;
    const worldY = (anchorY - this.viewport.y) / this.viewport.scale;

    this.viewport.x = anchorX - worldX * nextScale;
    this.viewport.y = anchorY - worldY * nextScale;
    this.viewport.scale = nextScale;
    this.applyViewport();
  }

  private applyViewport(): void {
    if (!this.elements) {
      return;
    }

    this.elements.stage.style.transform = `translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.scale})`;
  }

  private applyAppearanceAttributes(): void {
    const appearance = this.plugin.getAppearanceSettings();
    this.contentEl.dataset.oxmBackgroundStyle = appearance.backgroundStyle;
    this.contentEl.dataset.oxmNodeShape = appearance.nodeShape;
    this.contentEl.dataset.oxmConnectionStyle = appearance.connectionStyle;
  }

  private renderUndoBar(): void {
    if (!this.elements) {
      return;
    }

    const { undoBar, undoMessage } = this.elements;
    const undo = this.undoHistory[this.undoHistory.length - 1];
    if (!undo || this.undoBarDismissed) {
      undoBar.classList.remove("is-visible");
      undoMessage.textContent = "";
      return;
    }

    undoMessage.textContent = `${undo.label}.`;
    undoBar.classList.add("is-visible");
  }

  private applyPendingSelection(parsed: MindMapDocument): void {
    const pending = this.pendingSelection;
    this.pendingSelection = null;

    if (!pending) {
      return;
    }

    if (pending.source.type === "node-id") {
      if (parsed.nodesById.has(pending.source.nodeId)) {
        this.selectedNodeId = pending.source.nodeId;
      }
      return;
    }

    const match = findInsertedNode(parsed, pending.source.selection);
    if (!match) {
      return;
    }

    this.selectedNodeId = match.id;
    if (pending.source.startEditing) {
      this.editingNodeId = match.id;
    }
  }

  private async applyStructureEdit(
    patchFn: typeof insertSiblingNode | typeof insertChildNode,
    node: MindMapNode,
  ): Promise<void> {
    if (!this.file) {
      return;
    }

    this.isApplyingLocalChange = true;

    try {
      const content = await this.app.vault.read(this.file);
      const patch = patchFn(content, node);
      this.pendingSelection = patch.insertedNode
        ? {
            source: {
              type: "inserted",
              selection: patch.insertedNode,
              startEditing: true,
            },
          }
        : null;
      if (patch.content !== content) {
        await this.app.vault.modify(this.file, patch.content);
        const beforeLayout = cloneLayoutOffsets(this.nodeLayoutOffsets);
        this.nodeLayoutOffsets = {};
        await this.plugin.setLayoutForFile(this.file.path, {});
        this.pushUndoEntry({
          filePath: this.file.path,
          label:
            patchFn === insertChildNode
              ? `Added child to “${node.label || node.text}”`
              : `Added sibling near “${node.label || node.text}”`,
          beforeContent: content,
          afterContent: patch.content,
          beforeLayout,
          afterLayout: {},
          restoreSelectionNodeId: node.id,
        });
      }
      await this.refresh();
    } catch (error) {
      if (error instanceof StructurePatchError) {
        new Notice(error.message);
        if (error.code === "STALE_SOURCE") {
          await this.refresh();
        }
        return;
      }

      new Notice("Failed to update the note structure.");
    } finally {
      this.isApplyingLocalChange = false;
    }
  }

  private async jumpToNodeSource(node: MindMapNode): Promise<void> {
    if (!this.file) {
      return;
    }

    if (node.source.kind === "virtual-root") {
      await this.plugin.jumpToFilePosition(this.file, 0, 0);
      return;
    }

    const span = node.source.span;
    if (!span) {
      new Notice("This topic does not have a source position yet.");
      return;
    }

    await this.plugin.jumpToFilePosition(
      this.file,
      Math.max(0, span.line - 1),
      Math.max(0, span.column),
    );
  }

  private computeDropPreview(event: PointerEvent): DropPreviewState | null {
    if (!this.lastRenderedLayout || !this.nodeDragState || !this.elements) {
      return null;
    }

    const rect = this.elements.surface.getBoundingClientRect();
    const worldX = (event.clientX - rect.left - this.viewport.x) / this.viewport.scale;
    const worldY = (event.clientY - rect.top - this.viewport.y) / this.viewport.scale;
    const dragged = new Set(this.nodeDragState.subtreeNodeIds);
    let best:
      | {
          nodeId: string;
          position: MoveNodePosition;
          distance: number;
        }
      | null = null;

    for (const positioned of this.lastRenderedLayout.nodes.values()) {
      const candidate = positioned.node;
      if (dragged.has(candidate.id) || candidate.source.kind === "linked-note") {
        continue;
      }

      const rectDistance = distanceToRect(
        worldX,
        worldY,
        positioned.x,
        positioned.y,
        positioned.width,
        positioned.height,
      );

      if (rectDistance > 42) {
        continue;
      }

      const position = getDropPosition(worldX, worldY, positioned);
      if (!canPreviewDrop(candidate, position)) {
        continue;
      }

      if (!best || rectDistance < best.distance) {
        best = {
          nodeId: candidate.id,
          position,
          distance: rectDistance,
        };
      }
    }

    return best
      ? {
          targetNodeId: best.nodeId,
          position: best.position,
        }
      : null;
  }

  private async applyDragMove(
    anchorNodeId: string,
    dropPreview: DropPreviewState,
    beforeLayout: Record<string, NodeLayoutOffset>,
  ): Promise<void> {
    if (!this.file || !this.parsed) {
      return;
    }

    const sourceNode = this.parsed.nodesById.get(anchorNodeId);
    const targetNode = this.parsed.nodesById.get(dropPreview.targetNodeId);
    if (!sourceNode || !targetNode) {
      await this.refresh();
      return;
    }

    this.isApplyingLocalChange = true;

    try {
      const content = await this.app.vault.read(this.file);
      const patch = moveNode(
        content,
        this.parsed,
        sourceNode,
        targetNode,
        dropPreview.position,
      );
      this.pendingSelection = patch.insertedNode
        ? {
            source: {
              type: "inserted",
              selection: patch.insertedNode,
              startEditing: false,
            },
          }
        : null;
      await this.app.vault.modify(this.file, patch.content);
      this.nodeLayoutOffsets = {};
      await this.plugin.setLayoutForFile(this.file.path, {});
      this.pushUndoEntry({
        filePath: this.file.path,
        label: `Moved “${sourceNode.label || sourceNode.text}”`,
        beforeContent: content,
        afterContent: patch.content,
        beforeLayout,
        afterLayout: {},
        restoreSelectionNodeId: sourceNode.id,
      });
      await this.refresh();
    } catch (error) {
      this.nodeLayoutOffsets = cloneLayoutOffsets(beforeLayout);
      if (error instanceof StructurePatchError) {
        new Notice(error.message);
        if (error.code === "STALE_SOURCE") {
          await this.refresh();
        } else {
          this.render();
        }
        return;
      }

      new Notice("Failed to move the topic.");
      await this.refresh();
    } finally {
      this.isApplyingLocalChange = false;
    }
  }

  private async persistLayoutDrag(
    anchorNodeId: string,
    beforeLayout: Record<string, NodeLayoutOffset>,
  ): Promise<void> {
    if (!this.file) {
      return;
    }

    const afterLayout = cloneLayoutOffsets(this.nodeLayoutOffsets);
    if (layoutOffsetsEqual(beforeLayout, afterLayout)) {
      this.render();
      return;
    }

    this.isApplyingLocalChange = true;

    try {
      const content = await this.app.vault.read(this.file);
      await this.plugin.setLayoutForFile(this.file.path, afterLayout);
      this.pushUndoEntry({
        filePath: this.file.path,
        label: "Moved topic layout",
        beforeContent: content,
        afterContent: content,
        beforeLayout,
        afterLayout,
        restoreSelectionNodeId: anchorNodeId,
      });
      this.render();
      this.renderUndoBar();
    } catch {
      this.nodeLayoutOffsets = cloneLayoutOffsets(beforeLayout);
      this.render();
      new Notice("Failed to save the topic layout.");
    } finally {
      this.isApplyingLocalChange = false;
    }
  }

  private pushUndoEntry(entry: UndoHistoryEntry): void {
    this.undoHistory.push({
      ...entry,
      beforeLayout: cloneLayoutOffsets(entry.beforeLayout),
      afterLayout: cloneLayoutOffsets(entry.afterLayout),
    });
    if (this.undoHistory.length > 50) {
      this.undoHistory.shift();
    }
    this.undoBarDismissed = false;
    this.renderUndoBar();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countDescendants(node: MindMapNode): number {
  let count = 0;
  for (const child of node.children) {
    count += 1 + countDescendants(child);
  }
  return count;
}

function collectSubtreeNodeIds(node: MindMapNode): string[] {
  const ids = [node.id];
  for (const child of node.children) {
    ids.push(...collectSubtreeNodeIds(child));
  }
  return ids;
}

function canPreviewDrop(node: MindMapNode, position: MoveNodePosition): boolean {
  if (position === "child") {
    return node.source.kind !== "linked-note";
  }

  return node.source.kind === "heading" || node.source.kind === "overflow-list";
}

function getDropPosition(
  worldX: number,
  worldY: number,
  positioned: PositionedMindMapNode,
): MoveNodePosition {
  if (positioned.node.source.kind === "virtual-root") {
    return "child";
  }

  const childThreshold = positioned.x + positioned.width * 0.62;
  if (worldX >= childThreshold) {
    return "child";
  }

  const midY = positioned.y + positioned.height / 2;
  return worldY <= midY ? "before" : "after";
}

function distanceToRect(
  x: number,
  y: number,
  rectX: number,
  rectY: number,
  rectWidth: number,
  rectHeight: number,
): number {
  const dx = Math.max(rectX - x, 0, x - (rectX + rectWidth));
  const dy = Math.max(rectY - y, 0, y - (rectY + rectHeight));
  return Math.hypot(dx, dy);
}

function buildPreviewCurve(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): string {
  const delta = Math.abs(endX - startX);
  const curve = Math.max(26, delta * 0.34);
  const direction = endX >= startX ? 1 : -1;
  return `M ${startX} ${startY} C ${startX + curve * direction} ${startY}, ${endX - curve * direction} ${endY}, ${endX} ${endY}`;
}

function cloneLayoutOffsets(
  layout: Record<string, NodeLayoutOffset>,
): Record<string, NodeLayoutOffset> {
  const clone: Record<string, NodeLayoutOffset> = {};
  for (const [nodeId, offset] of Object.entries(layout)) {
    clone[nodeId] = { x: offset.x, y: offset.y };
  }
  return clone;
}

function layoutOffsetsEqual(
  left: Record<string, NodeLayoutOffset>,
  right: Record<string, NodeLayoutOffset>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (const [nodeId, leftOffset] of leftEntries) {
    const rightOffset = right[nodeId];
    if (!rightOffset || leftOffset.x !== rightOffset.x || leftOffset.y !== rightOffset.y) {
      return false;
    }
  }

  return true;
}

function findParentNode(root: MindMapNode, targetId: string): MindMapNode | null {
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

function findInsertedNode(
  document: MindMapDocument,
  selection: InsertedNodeSelection,
): MindMapNode | null {
  for (const node of document.nodesById.values()) {
    if (
      node.source.kind === selection.kind &&
      node.source.span?.line === selection.line &&
      node.source.depth === selection.depth &&
      node.text === selection.text
    ) {
      return node;
    }
  }

  return null;
}

async function confirmDeleteWithChildren(
  view: MindMapView,
  node: MindMapNode,
  descendantCount: number,
): Promise<boolean> {
  const modal = new DeleteTopicConfirmModal(
    view.app,
    node.label || node.text,
    descendantCount,
  );
  return modal.openAndWait();
}

class DeleteTopicConfirmModal extends Modal {
  private topicLabel: string;
  private descendantCount: number;
  private resolvePromise: ((value: boolean) => void) | null = null;

  constructor(app: MindMapView["app"], topicLabel: string, descendantCount: number) {
    super(app);
    this.topicLabel = topicLabel;
    this.descendantCount = descendantCount;
  }

  openAndWait(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("oxm-delete-modal");
    contentEl.empty();

    const title = contentEl.createEl("h3", {
      text: "Delete topic?",
      cls: "oxm-delete-modal-title",
    });
    title.tabIndex = -1;

    const body = contentEl.createEl("p", {
      cls: "oxm-delete-modal-copy",
      text:
        this.descendantCount === 1
          ? `Deleting “${this.topicLabel}” will also remove 1 nested topic from the Markdown note.`
          : `Deleting “${this.topicLabel}” will also remove ${this.descendantCount} nested topics from the Markdown note.`,
    });

    const footer = contentEl.createDiv("oxm-delete-modal-actions");

    const cancelButton = footer.createEl("button", {
      text: "Cancel",
      cls: "mod-muted oxm-delete-modal-button",
    });
    cancelButton.type = "button";
    cancelButton.addEventListener("click", () => this.finish(false));

    const confirmButton = footer.createEl("button", {
      text: "Delete topic",
      cls: "mod-warning oxm-delete-modal-button is-danger",
    });
    confirmButton.type = "button";
    confirmButton.addEventListener("click", () => this.finish(true));

    window.requestAnimationFrame(() => {
      confirmButton.focus();
    });
  }

  onClose(): void {
    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    this.contentEl.empty();
    if (resolve) {
      resolve(false);
    }
  }

  private finish(confirmed: boolean): void {
    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    this.close();
    resolve?.(confirmed);
  }
}
