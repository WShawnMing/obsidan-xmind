import {
  associationsEqual,
  buildAssociationEndpoint,
  cloneAssociations,
  createAssociationId,
  reconcileAssociations,
} from "../associations";
import {
  ItemView,
  Menu,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
  getLinkpath,
  normalizePath,
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
import { applyPendingTypingSeed } from "./direct-typing";
import { findNavigationTarget, findParentNode } from "./navigation";
import type {
  MindMapAssociation,
  MindMapDocument,
  MindMapInlineToken,
  MindMapLayout,
  MindMapNode,
  MindMapViewState,
  NodeLayoutOffset,
  NodeSizeOverride,
  PositionedMindMapNode,
  SourceDocumentRef,
} from "../types";
import {
  StructurePatchError,
  type CopiedMindMapSubtree,
  type InsertedNodeSelection,
  type MoveNodePosition,
} from "../write/structure-patch-writer";
import {
  copyNodeSubtreeFromMarkdown,
  deleteNodeInMarkdown,
  insertChildNodeInMarkdown,
  insertSiblingNodeInMarkdown,
  moveNodeInMarkdown,
  type MarkdownTextOperationResult,
  pasteNodeSubtreeAfterInMarkdown,
  renameNodeInMarkdown,
} from "../write/markdown-text-operation";
import { TitlePatchError } from "../write/title-patch-writer";
import type ObsidianXMindPlugin from "../main";

const SVG_NS = "http://www.w3.org/2000/svg";
const DIRECT_TYPING_SEED_DELAY_MS = 72;

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
  showBanner: boolean;
  beforeContent: string;
  afterContent: string;
  beforeLayout: Record<string, NodeLayoutOffset>;
  afterLayout: Record<string, NodeLayoutOffset>;
  beforeNodeSizes?: Record<string, NodeSizeOverride>;
  afterNodeSizes?: Record<string, NodeSizeOverride>;
  beforeAssociations: MindMapAssociation[];
  afterAssociations: MindMapAssociation[];
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

interface AssociationLabelDragState {
  pointerId: number;
  associationId: string;
  startClientX: number;
  startClientY: number;
  startOffset: NodeLayoutOffset;
  beforeAssociations: MindMapAssociation[];
  didDrag: boolean;
}

interface NodeResizeState {
  pointerId: number;
  nodeId: string;
  startClientX: number;
  startClientY: number;
  startWidth: number;
  startHeight: number;
  beforeNodeSizes: Record<string, NodeSizeOverride>;
  didResize: boolean;
}

interface RenderedAssociation {
  association: MindMapAssociation;
  fromNode: MindMapNode;
  toNode: MindMapNode;
  path: string;
  labelX: number;
  labelY: number;
}

interface PendingTypingStart {
  kind: "node" | "association";
  id: string;
  seedText: string;
  timeoutId: number;
}

export class MindMapView extends ItemView {
  private plugin: ObsidianXMindPlugin;
  private file: TFile | null = null;
  private parsed: MindMapDocument | null = null;
  private elements: ViewElements | null = null;
  private selectedNodeId: string | null = null;
  private selectedAssociationId: string | null = null;
  private editingNodeId: string | null = null;
  private editingAssociationId: string | null = null;
  private editorInput: HTMLInputElement | null = null;
  private pendingSelection: PendingSelectionState | null = null;
  private undoHistory: UndoHistoryEntry[] = [];
  private undoBarDismissed = false;
  private nodeLayoutOffsets: Record<string, NodeLayoutOffset> = {};
  private nodeSizeOverrides: Record<string, NodeSizeOverride> = {};
  private associations: MindMapAssociation[] = [];
  private lastRenderedLayout: MindMapLayout | null = null;
  private nodeDragState: NodeDragState | null = null;
  private nodeResizeState: NodeResizeState | null = null;
  private associationLabelDragState: AssociationLabelDragState | null = null;
  private dropPreview: DropPreviewState | null = null;
  private pendingAssociationSourceNodeId: string | null = null;
  private pendingEditOnClickNodeId: string | null = null;
  private editingSeedText: string | null = null;
  private isEditorComposing = false;
  private commitAfterComposition = false;
  private suppressNextNodeClick = false;
  private isCommittingEdit = false;
  private isApplyingLocalChange = false;
  private isUndoing = false;
  private undoBarTimeout: number | null = null;
  private pendingTypingStart: PendingTypingStart | null = null;
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
    this.registerDomEvent(window, "keydown", (event) => this.onWindowKeyDown(event), true);
    this.render();
  }

  async onClose(): Promise<void> {
    this.clearUndoBarTimeout();
    this.clearPendingTypingStart();
    this.endEditing(false);
  }

  isDisplayingFile(filePath: string): boolean {
    return this.file?.path === filePath;
  }

  getCurrentFilePath(): string | null {
    return this.file?.path ?? null;
  }

  private getSourceDocumentRef(): SourceDocumentRef | null {
    if (!this.file) {
      return null;
    }

    return {
      path: this.file.path,
      basename: this.file.basename,
    };
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
      this.selectedAssociationId = null;
      this.undoHistory = [];
      this.undoBarDismissed = false;
      this.clearUndoBarTimeout();
      this.nodeLayoutOffsets = {};
      this.nodeSizeOverrides = {};
      this.associations = [];
      this.lastRenderedLayout = null;
      this.nodeDragState = null;
      this.nodeResizeState = null;
      this.dropPreview = null;
      this.pendingAssociationSourceNodeId = null;
      this.clearPendingTypingStart();
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
    this.nodeSizeOverrides = this.plugin.getNodeSizesForFile(this.file.path);
    const storedAssociations = this.plugin.getAssociationsForFile(this.file.path);
    const validNodeIds = new Set(parsed.nodesById.keys());
    let pruned = false;
    let prunedSizes = false;
    for (const nodeId of Object.keys(this.nodeLayoutOffsets)) {
      if (!validNodeIds.has(nodeId)) {
        delete this.nodeLayoutOffsets[nodeId];
        pruned = true;
      }
    }
    for (const nodeId of Object.keys(this.nodeSizeOverrides)) {
      if (!validNodeIds.has(nodeId)) {
        delete this.nodeSizeOverrides[nodeId];
        prunedSizes = true;
      }
    }
    if (pruned) {
      void this.plugin.setLayoutForFile(this.file.path, this.nodeLayoutOffsets);
    }
    if (prunedSizes) {
      void this.plugin.setNodeSizesForFile(this.file.path, this.nodeSizeOverrides);
    }

    const associationReconcile = reconcileAssociations(parsed, storedAssociations);
    this.associations = associationReconcile.associations;
    if (associationReconcile.changed) {
      void this.plugin.setAssociationsForFile(this.file.path, associationReconcile.associations);
    }

    const latestUndo = this.undoHistory[this.undoHistory.length - 1];
    if (
      !this.isApplyingLocalChange &&
      latestUndo &&
      (latestUndo.filePath !== this.file.path ||
        latestUndo.afterContent !== content ||
        !layoutOffsetsEqual(latestUndo.afterLayout, this.nodeLayoutOffsets) ||
        !nodeSizesEqual(latestUndo.afterNodeSizes ?? {}, this.nodeSizeOverrides) ||
        !associationsEqual(latestUndo.afterAssociations, this.associations))
    ) {
      this.undoHistory = [];
      this.undoBarDismissed = false;
    }

    this.parsed = parsed;
    this.clearPendingTypingStart();
    this.endEditing(false);
    if (this.pendingSelection) {
      this.applyPendingSelection(parsed);
    }
    if (!this.selectedNodeId || !parsed.nodesById.has(this.selectedNodeId)) {
      this.selectedNodeId = parsed.root.id;
    }
    if (
      this.selectedAssociationId &&
      !this.associations.some((association) => association.id === this.selectedAssociationId)
    ) {
      this.selectedAssociationId = null;
    }
    if (
      this.pendingAssociationSourceNodeId &&
      !parsed.nodesById.has(this.pendingAssociationSourceNodeId)
    ) {
      this.pendingAssociationSourceNodeId = null;
    }
    this.render();
    this.renderUndoBar();
  }

  async editSelectedNode(): Promise<void> {
    if (this.selectedAssociationId) {
      this.startEditingAssociation(this.selectedAssociationId);
      return;
    }

    if (!this.selectedNodeId) {
      return;
    }
    this.startEditing(this.selectedNodeId);
  }

  canUndoLastAction(): boolean {
    return (
      !!this.file &&
      !this.editingNodeId &&
      !this.editingAssociationId &&
      !this.isCommittingEdit &&
      !this.hasTextInputFocus() &&
      this.undoHistory.length > 0
    );
  }

  canCopySelectedNode(): boolean {
    if (
      !this.file ||
      !this.parsed ||
      this.editingNodeId ||
      this.editingAssociationId ||
      !this.selectedNodeId ||
      this.hasTextInputFocus()
    ) {
      return false;
    }

    const node = this.parsed.nodesById.get(this.selectedNodeId);
    return !!node && (node.source.kind === "heading" || node.source.kind === "overflow-list");
  }

  canPasteAfterSelectedNode(): boolean {
    if (
      !this.file ||
      !this.parsed ||
      this.editingNodeId ||
      this.editingAssociationId ||
      !this.selectedNodeId ||
      this.hasTextInputFocus()
    ) {
      return false;
    }

    const node = this.parsed.nodesById.get(this.selectedNodeId);
    if (!node) {
      return false;
    }

    if (node.source.kind === "heading" || node.source.kind === "overflow-list") {
      return true;
    }

    return (
      node.source.kind !== "linked-note" &&
      node.source.kind !== "image-embed" &&
      this.plugin.hasMindMapClipboard()
    );
  }

  canDeleteSelectedNode(): boolean {
    if (
      !this.file ||
      !this.parsed ||
      this.editingNodeId ||
      this.editingAssociationId ||
      !this.selectedNodeId ||
      this.hasTextInputFocus()
    ) {
      return false;
    }

    const node = this.parsed.nodesById.get(this.selectedNodeId);
    if (!node) {
      return false;
    }

    return (
      node.id !== this.parsed.root.id &&
      node.source.kind !== "virtual-root" &&
      node.source.kind !== "linked-note" &&
      node.source.kind !== "image-embed"
    );
  }

  canNavigateSelection(): boolean {
    return (
      !!this.parsed &&
      !!this.selectedNodeId &&
      !this.editingNodeId &&
      !this.editingAssociationId &&
      !this.hasTextInputFocus() &&
      !!this.lastRenderedLayout
    );
  }

  canStartRelationshipFromSelectedNode(): boolean {
    if (
      !this.file ||
      !this.parsed ||
      !this.selectedNodeId ||
      this.editingNodeId ||
      this.editingAssociationId ||
      this.hasTextInputFocus()
    ) {
      return false;
    }

    const node = this.parsed.nodesById.get(this.selectedNodeId);
    return !!node && node.source.kind !== "virtual-root";
  }

  startRelationshipFromSelectedNode(): void {
    if (!this.canStartRelationshipFromSelectedNode() || !this.selectedNodeId) {
      return;
    }

    this.selectedAssociationId = null;
    this.pendingAssociationSourceNodeId = this.selectedNodeId;
    this.contentEl.focus();
    this.render();
    new Notice("Select another topic to create a relationship.");
  }

  navigateSelection(direction: "left" | "right" | "up" | "down"): void {
    if (!this.parsed || !this.selectedNodeId) {
      return;
    }

    const currentNode = this.parsed.nodesById.get(this.selectedNodeId);
    if (!currentNode) {
      return;
    }

    const targetNodeId = findNavigationTarget(
      this.parsed.root,
      currentNode.id,
      direction,
    );
    if (targetNodeId === currentNode.id) {
      return;
    }

    this.selectedNodeId = targetNodeId;
    this.contentEl.focus();
    this.render();
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
      this.clearUndoBarTimeout();
      this.renderUndoBar();
      return;
    }

    try {
      const currentContent = await this.app.vault.read(this.file);
      const currentLayout = this.plugin.getLayoutForFile(this.file.path);
      const currentNodeSizes = this.plugin.getNodeSizesForFile(this.file.path);
      const currentAssociations = this.plugin.getAssociationsForFile(this.file.path);
      if (
        currentContent !== entry.afterContent ||
        !layoutOffsetsEqual(currentLayout, entry.afterLayout) ||
        !nodeSizesEqual(currentNodeSizes, entry.afterNodeSizes ?? {}) ||
        !associationsEqual(currentAssociations, entry.afterAssociations)
      ) {
        this.undoHistory = [];
        this.undoBarDismissed = false;
        this.clearUndoBarTimeout();
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
      this.undoBarDismissed = true;
      this.clearUndoBarTimeout();
      this.nodeLayoutOffsets = cloneLayoutOffsets(entry.beforeLayout);
      this.nodeSizeOverrides = cloneNodeSizes(entry.beforeNodeSizes ?? {});
      this.associations = cloneAssociations(entry.beforeAssociations);
      await this.plugin.setLayoutForFile(this.file.path, entry.beforeLayout);
      await this.plugin.setNodeSizesForFile(this.file.path, entry.beforeNodeSizes ?? {});
      await this.plugin.setAssociationsForFile(this.file.path, entry.beforeAssociations);
      await this.app.vault.modify(this.file, entry.beforeContent);
      await this.refresh();
    } catch {
      new Notice("Failed to undo the last mind map change.");
    } finally {
      this.isUndoing = false;
    }
  }

  async copySelectedNode(): Promise<void> {
    if (!this.file || !this.selectedNodeId) {
      return;
    }

    try {
      const sourceRef = this.getSourceDocumentRef();
      if (!sourceRef) {
        return;
      }

      const content = await this.app.vault.read(this.file);
      const copied = copyNodeSubtreeFromMarkdown(sourceRef, content, this.selectedNodeId);
      this.plugin.setMindMapClipboard(copied);
      void this.writeClipboardPreview(copied);
      new Notice(`Copied “${copied.text}”.`);
    } catch (error) {
      if (error instanceof StructurePatchError) {
        new Notice(error.message);
        return;
      }

      new Notice("Failed to copy the selected topic.");
    }
  }

  async pasteAfterSelectedNode(): Promise<void> {
    if (!this.file || !this.parsed || !this.selectedNodeId) {
      return;
    }

    const selectedNode = this.parsed.nodesById.get(this.selectedNodeId);
    if (!selectedNode) {
      return;
    }

    const clipboardText = await this.readClipboardText();
    const copied = this.plugin.getMindMapClipboard();
    const structuralClipboardText = copied ? copied.lines.join("\n") : null;
    const normalizedClipboardText = normalizePastedTopicText(clipboardText);
    const shouldReplaceTitle =
      (selectedNode.source.kind === "heading" || selectedNode.source.kind === "overflow-list") &&
      normalizedClipboardText.length > 0 &&
      (!copied || !structuralClipboardText || clipboardText !== structuralClipboardText);

    if (shouldReplaceTitle) {
      try {
        const targetNodeId = this.selectedNodeId;
        await this.applyMarkdownTextOperation((sourceRef, content) =>
          renameNodeInMarkdown(sourceRef, content, targetNodeId, normalizedClipboardText),
        );
      } catch (error) {
        if (error instanceof TitlePatchError) {
          if (error.code === "STALE_SOURCE") {
            new Notice("The note changed. Refreshing the mind map before retry.");
            await this.refresh();
          } else {
            new Notice(error.message);
          }
          return;
        }

        new Notice("Failed to paste text into the selected topic.");
      }
      return;
    }

    if (!copied) {
      return;
    }

    try {
      const targetNodeId = this.selectedNodeId;
      await this.applyMarkdownTextOperation((sourceRef, content) =>
        pasteNodeSubtreeAfterInMarkdown(sourceRef, content, targetNodeId, copied),
      );
    } catch (error) {
      if (error instanceof StructurePatchError) {
        new Notice(error.message);
        if (error.code === "STALE_SOURCE") {
          await this.refresh();
        }
        return;
      }

      new Notice("Failed to paste the copied topic.");
    }
  }

  async addSiblingNode(): Promise<void> {
    if (!this.file || !this.selectedNodeId) {
      return;
    }
    const nodeId = this.selectedNodeId;

    try {
      await this.applyMarkdownTextOperation((sourceRef, content) =>
        insertSiblingNodeInMarkdown(sourceRef, content, nodeId),
      );
    } catch (error) {
      if (error instanceof StructurePatchError) {
        new Notice(error.message);
        if (error.code === "STALE_SOURCE") {
          await this.refresh();
        }
        return;
      }

      new Notice("Failed to update the note structure.");
    }
  }

  async addChildNode(): Promise<void> {
    if (!this.file || !this.selectedNodeId) {
      return;
    }
    const nodeId = this.selectedNodeId;

    try {
      await this.applyMarkdownTextOperation((sourceRef, content) =>
        insertChildNodeInMarkdown(sourceRef, content, nodeId),
      );
    } catch (error) {
      if (error instanceof StructurePatchError) {
        new Notice(error.message);
        if (error.code === "STALE_SOURCE") {
          await this.refresh();
        }
        return;
      }

      new Notice("Failed to update the note structure.");
    }
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

    try {
      const nodeId = node.id;
      await this.applyMarkdownTextOperation((sourceRef, content) =>
        deleteNodeInMarkdown(sourceRef, content, nodeId),
      );
    } catch (error) {
      if (error instanceof StructurePatchError) {
        new Notice(error.message);
        if (error.code === "STALE_SOURCE") {
          await this.refresh();
        }
        return;
      }

      new Notice("Failed to delete the selected topic.");
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
      this.clearUndoBarTimeout();
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
    this.contentEl.addEventListener("compositionstart", () => this.onCompositionStart());

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
      this.nodeSizeOverrides,
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

    const renderedAssociations = this.getRenderedAssociations(layout);

    for (const association of renderedAssociations) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", association.path);
      path.classList.add("oxm-association");
      if (association.association.id === this.selectedAssociationId) {
        path.classList.add("is-selected");
      }
      path.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      path.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.selectedAssociationId = association.association.id;
        this.selectedNodeId = null;
        this.pendingAssociationSourceNodeId = null;
        this.contentEl.focus();
        this.render();
      });
      path.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.startEditingAssociation(association.association.id);
      });
      path.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.selectedAssociationId = association.association.id;
        this.selectedNodeId = null;
        this.pendingAssociationSourceNodeId = null;
        this.contentEl.focus();
        this.render();
        this.openAssociationContextMenu(event, association.association);
      });
      svg.append(path);
    }

    for (const association of renderedAssociations) {
      const labelEl = this.renderAssociationLabel(association);
      if (labelEl) {
        nodes.append(labelEl);
      }
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

    if (node.id === this.pendingAssociationSourceNodeId) {
      nodeEl.classList.add("is-association-source");
    }

    if (positioned.depth === 0) {
      nodeEl.classList.add("is-root");
    }

    if (node.source.kind === "linked-note") {
      nodeEl.classList.add("is-linked-note");
    }

    if (node.source.kind === "image-embed") {
      nodeEl.classList.add("is-image-embed");
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

    if (this.nodeResizeState?.nodeId === node.id && this.nodeResizeState.didResize) {
      nodeEl.classList.add("is-resizing");
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
      const initialValue = this.editingSeedText ?? node.text;
      const input = document.createElement("input");
      input.className = "oxm-node-input";
      input.type = "text";
      input.value = initialValue;
      input.addEventListener("keydown", (event) => {
        if (event.isComposing || this.isEditorComposing) {
          return;
        }

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
      input.addEventListener("compositionstart", () => {
        this.clearPendingTypingStart();
        this.isEditorComposing = true;
        this.commitAfterComposition = false;
      });
      input.addEventListener("compositionend", () => {
        this.isEditorComposing = false;
        if (this.commitAfterComposition) {
          this.commitAfterComposition = false;
          void this.commitEditing();
        }
      });
      input.addEventListener("blur", () => {
        if (this.isEditorComposing) {
          this.commitAfterComposition = true;
          return;
        }
        void this.commitEditing();
      });
      input.addEventListener("input", () => {
        this.handleEditorInput();
      });
      contentEl.append(input);
      this.editorInput = input;
      window.requestAnimationFrame(() => {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      });
      this.editingSeedText = null;
    } else if (node.source.kind === "image-embed") {
      contentEl.append(this.renderImageEmbed(node));
    } else {
      for (const token of node.tokens) {
        contentEl.append(this.renderToken(token));
      }
    }

    nodeEl.append(contentEl);
    if (!isEditing) {
      const resizeHandle = document.createElement("button");
      resizeHandle.className = "oxm-node-resize-handle";
      resizeHandle.type = "button";
      resizeHandle.setAttribute("aria-label", "Resize topic");
      resizeHandle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      resizeHandle.addEventListener("pointerdown", (event) => {
        this.onNodeResizePointerDown(event, node.id);
      });
      nodeEl.append(resizeHandle);
    }
    nodeEl.addEventListener("pointerdown", (event) => {
      this.onNodePointerDown(event, node.id);
    });
    nodeEl.addEventListener("click", (event) => {
      if (this.suppressNextNodeClick) {
        this.suppressNextNodeClick = false;
        this.pendingEditOnClickNodeId = null;
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

      if (
        this.pendingAssociationSourceNodeId &&
        this.pendingAssociationSourceNodeId !== node.id
      ) {
        event.preventDefault();
        event.stopPropagation();
        void this.createAssociation(this.pendingAssociationSourceNodeId, node.id);
        return;
      }

      if (this.pendingEditOnClickNodeId === node.id) {
        this.pendingEditOnClickNodeId = null;
        this.render();
        return;
      }

      if (editable && event.detail >= 2) {
        this.startEditing(node.id);
        return;
      }
    });
    nodeEl.addEventListener("dblclick", () => {
      this.pendingEditOnClickNodeId = null;
      this.startEditing(node.id);
    });
    nodeEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selectedNodeId = node.id;
      this.pendingEditOnClickNodeId = null;
      this.contentEl.focus();
      this.render();
      this.openNodeContextMenu(event, node);
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

  private renderImageEmbed(node: MindMapNode): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "oxm-image-card";

    const media = document.createElement("div");
    media.className = "oxm-image-media";
    const image = node.image;
    const resolvedSource = image ? this.resolveImageSource(image.target) : null;

    if (image && resolvedSource) {
      const img = document.createElement("img");
      img.className = "oxm-image-preview";
      img.src = resolvedSource;
      img.alt = image.alt || node.label || "Image";
      img.loading = "lazy";
      img.draggable = false;
      media.append(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "oxm-image-placeholder";
      placeholder.textContent = image?.alt || node.label || "Image";
      media.append(placeholder);
      media.classList.add("is-missing");
    }

    const caption = document.createElement("div");
    caption.className = "oxm-image-caption";

    const captionTitle = document.createElement("div");
    captionTitle.className = "oxm-image-caption-title";
    captionTitle.textContent = node.label || image?.target || "Image";
    caption.append(captionTitle);

    if (image?.title?.trim()) {
      const note = document.createElement("div");
      note.className = "oxm-image-caption-note";
      note.textContent = image.title.trim();
      caption.append(note);
    }

    wrapper.append(media, caption);
    return wrapper;
  }

  private renderAssociationLabel(rendered: RenderedAssociation): HTMLElement | null {
    const association = rendered.association;
    const isEditing = this.editingAssociationId === association.id;
    const label = association.label?.trim() ?? "";
    const shouldShow = isEditing || this.selectedAssociationId === association.id || label.length > 0;
    if (!shouldShow) {
      return null;
    }

    const element = document.createElement("div");
    element.className = "oxm-association-label";
    element.style.left = `${rendered.labelX}px`;
    element.style.top = `${rendered.labelY}px`;

    if (this.selectedAssociationId === association.id && !isEditing) {
      element.classList.add("is-selected");
    }

    if (isEditing) {
      element.classList.add("is-editing");
      const input = document.createElement("input");
      input.className = "oxm-association-input";
      input.type = "text";
      input.value = this.editingSeedText ?? label;
      input.placeholder = "Relationship";
      input.addEventListener("keydown", (event) => {
        if (event.isComposing || this.isEditorComposing) {
          return;
        }

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
      input.addEventListener("compositionstart", () => {
        this.clearPendingTypingStart();
        this.isEditorComposing = true;
        this.commitAfterComposition = false;
      });
      input.addEventListener("compositionend", () => {
        this.isEditorComposing = false;
        if (this.commitAfterComposition) {
          this.commitAfterComposition = false;
          void this.commitEditing();
        }
      });
      input.addEventListener("blur", () => {
        if (this.isEditorComposing) {
          this.commitAfterComposition = true;
          return;
        }
        void this.commitEditing();
      });
      input.addEventListener("input", () => {
        this.handleEditorInput();
      });
      element.append(input);
      this.editorInput = input;
      window.requestAnimationFrame(() => {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      });
      this.editingSeedText = null;
      return element;
    }

    const text = document.createElement("div");
    text.className = "oxm-association-label-text";
    text.textContent = label || "Add relationship";
    if (label.length === 0) {
      element.classList.add("is-placeholder");
    }
    element.append(text);

    element.addEventListener("pointerdown", (event) => {
      this.onAssociationLabelPointerDown(event, association.id);
    });
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selectedAssociationId = association.id;
      this.selectedNodeId = null;
      this.pendingAssociationSourceNodeId = null;
      this.contentEl.focus();
      this.render();
    });
    element.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.startEditingAssociation(association.id);
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selectedAssociationId = association.id;
      this.selectedNodeId = null;
      this.pendingAssociationSourceNodeId = null;
      this.contentEl.focus();
      this.render();
      this.openAssociationContextMenu(event, association);
    });

    return element;
  }

  private startEditing(nodeId: string, seedText: string | null = null): void {
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
    this.selectedAssociationId = null;
    this.pendingAssociationSourceNodeId = null;
    this.clearPendingTypingStart();
    this.editingNodeId = nodeId;
    this.editingAssociationId = null;
    this.editingSeedText = seedText;
    this.render();
    this.focusEditorInput();
  }

  private startEditingAssociation(
    associationId: string,
    seedText: string | null = null,
  ): void {
    const association = this.associations.find((item) => item.id === associationId);
    if (!association) {
      return;
    }

    this.selectedNodeId = null;
    this.selectedAssociationId = associationId;
    this.pendingAssociationSourceNodeId = null;
    this.clearPendingTypingStart();
    this.editingNodeId = null;
    this.editingAssociationId = associationId;
    this.editingSeedText = seedText ?? association.label ?? "";
    this.render();
    this.focusEditorInput();
  }

  private focusEditorInput(): void {
    const input = this.editorInput;
    if (!input) {
      return;
    }

    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
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
      (event.target as HTMLElement).closest(
        ".oxm-token-link, .oxm-fold-badge, .oxm-node-resize-handle",
      )
    ) {
      return;
    }

    if (!this.parsed || !this.lastRenderedLayout) {
      return;
    }

    const wasSelected = this.selectedNodeId === nodeId;
    this.clearPendingTypingStart();
    this.selectedAssociationId = null;
    this.pendingEditOnClickNodeId = wasSelected ? null : nodeId;
    if (!wasSelected) {
      this.selectedNodeId = nodeId;
      this.selectedAssociationId = null;
      this.contentEl.focus();
    }

    if (
      this.pendingAssociationSourceNodeId &&
      this.pendingAssociationSourceNodeId !== nodeId
    ) {
      event.stopPropagation();
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

  private onNodeResizePointerDown(event: PointerEvent, nodeId: string): void {
    if (event.button !== 0 || this.editingNodeId || !this.lastRenderedLayout) {
      return;
    }

    const positioned = this.lastRenderedLayout.nodes.get(nodeId);
    if (!positioned) {
      return;
    }

    this.clearPendingTypingStart();
    this.selectedNodeId = nodeId;
    this.selectedAssociationId = null;
    this.pendingEditOnClickNodeId = null;
    this.pendingAssociationSourceNodeId = null;
    this.contentEl.focus();
    this.nodeResizeState = {
      pointerId: event.pointerId,
      nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidth: positioned.width,
      startHeight: positioned.height,
      beforeNodeSizes: cloneNodeSizes(this.nodeSizeOverrides),
      didResize: false,
    };
    this.elements?.surface.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  private onAssociationLabelPointerDown(event: PointerEvent, associationId: string): void {
    if (event.button !== 0 || this.editingNodeId || this.editingAssociationId) {
      return;
    }

    const association = this.associations.find((item) => item.id === associationId);
    if (!association) {
      return;
    }

    this.clearPendingTypingStart();
    this.selectedAssociationId = associationId;
    this.selectedNodeId = null;
    this.pendingAssociationSourceNodeId = null;
    this.contentEl.focus();

    this.associationLabelDragState = {
      pointerId: event.pointerId,
      associationId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffset: association.labelOffset
        ? { x: association.labelOffset.x, y: association.labelOffset.y }
        : { x: 0, y: 0 },
      beforeAssociations: cloneAssociations(this.associations),
      didDrag: false,
    };

    this.elements?.surface.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  private async commitEditing(): Promise<void> {
    if (!this.file || !this.editorInput) {
      return;
    }

    if (this.isCommittingEdit) {
      return;
    }

    if (this.editingAssociationId) {
      await this.commitAssociationEditing();
      return;
    }

    if (!this.parsed || !this.editingNodeId) {
      return;
    }

    this.isCommittingEdit = true;
    const nextTitle = this.editorInput.value;
    const editingNodeId = this.editingNodeId;

    try {
      this.endEditing(false);
      await this.applyMarkdownTextOperation((sourceRef, content) =>
        renameNodeInMarkdown(sourceRef, content, editingNodeId, nextTitle),
      );
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
      this.isCommittingEdit = false;
    }
  }

  private async commitAssociationEditing(): Promise<void> {
    if (!this.file || !this.editorInput || !this.editingAssociationId) {
      return;
    }

    if (this.isCommittingEdit) {
      return;
    }

    this.isCommittingEdit = true;
    const associationId = this.editingAssociationId;
    const nextLabel = normalizeAssociationLabel(this.editorInput.value);

    try {
      const beforeAssociations = cloneAssociations(this.associations);
      const nextAssociations = cloneAssociations(this.associations);
      const target = nextAssociations.find((association) => association.id === associationId);
      if (!target) {
        this.endEditing(false);
        this.render();
        return;
      }

      target.label = nextLabel || undefined;
      this.endEditing(false);

      if (associationsEqual(beforeAssociations, nextAssociations)) {
        this.render();
        return;
      }

      const content = await this.app.vault.read(this.file);
      await this.plugin.setAssociationsForFile(this.file.path, nextAssociations);
      this.associations = cloneAssociations(nextAssociations);
      this.selectedAssociationId = associationId;
      this.pushUndoEntry({
        filePath: this.file.path,
        label: nextLabel ? "Edited relationship text" : "Cleared relationship text",
        showBanner: false,
        beforeContent: content,
        afterContent: content,
        beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
        afterLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
        beforeAssociations,
        afterAssociations: nextAssociations,
        restoreSelectionNodeId: null,
      });
      this.render();
    } catch {
      this.endEditing(false);
      new Notice("Failed to update the relationship text.");
      this.render();
    } finally {
      this.isCommittingEdit = false;
    }
  }

  private endEditing(restoreSelection: boolean): void {
    if (restoreSelection && this.editingNodeId) {
      this.selectedNodeId = this.editingNodeId;
    }
    if (restoreSelection && this.editingAssociationId) {
      this.selectedAssociationId = this.editingAssociationId;
    }
    this.editingNodeId = null;
    this.editingAssociationId = null;
    this.editingSeedText = null;
    this.clearPendingTypingStart();
    this.isEditorComposing = false;
    this.commitAfterComposition = false;
    this.editorInput = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) {
      return;
    }

    if (this.editingNodeId || this.editingAssociationId) {
      return;
    }

    if (event.key === "Escape" && this.pendingAssociationSourceNodeId) {
      event.preventDefault();
      this.pendingAssociationSourceNodeId = null;
      this.render();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void this.undoLastAction();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void this.copySelectedNode();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void this.pasteAfterSelectedNode();
      return;
    }

    if ((event.metaKey || event.ctrlKey || event.altKey) && event.key !== "Backspace") {
      return;
    }

    if (
      this.selectedAssociationId &&
      (event.key === "Delete" || event.key === "Backspace")
    ) {
      event.preventDefault();
      void this.deleteAssociation(this.selectedAssociationId);
      return;
    }

    if (this.selectedAssociationId) {
      if (shouldStartTypingEdit(event)) {
        event.preventDefault();
        this.startDirectTypingEdit("association", this.selectedAssociationId, event.key);
        return;
      }

      if (event.key === "Enter" || event.key === "F2") {
        event.preventDefault();
        this.startEditingAssociation(this.selectedAssociationId);
        return;
      }
    }

    if (!this.selectedNodeId) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.navigateSelection("left");
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      this.navigateSelection("right");
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.navigateSelection("up");
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.navigateSelection("down");
      return;
    }

    if (shouldStartTypingEdit(event)) {
      event.preventDefault();
      this.pendingAssociationSourceNodeId = null;
      this.startDirectTypingEdit("node", this.selectedNodeId, event.key);
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

  private onWindowKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || !this.isActiveMindMapView() || this.hasTextInputFocus()) {
      return;
    }

    this.onKeyDown(event);
  }

  private onCompositionStart(): void {
    if (this.editingNodeId || this.editingAssociationId) {
      return;
    }

    this.clearPendingTypingStart();

    if (this.selectedAssociationId) {
      this.startEditingAssociation(this.selectedAssociationId, "");
      return;
    }

    if (!this.selectedNodeId) {
      return;
    }

    this.startEditing(this.selectedNodeId, "");
  }

  private onPointerDown(event: PointerEvent): void {
    if (
      (event.target as HTMLElement).closest(
        ".oxm-node, .oxm-fold-badge, .oxm-node-resize-handle",
      )
    ) {
      return;
    }

    this.clearPendingTypingStart();
    this.pendingEditOnClickNodeId = null;
    this.selectedAssociationId = null;
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
    if (this.nodeResizeState && event.pointerId === this.nodeResizeState.pointerId) {
      const positioned = this.lastRenderedLayout?.nodes.get(this.nodeResizeState.nodeId);
      if (!positioned) {
        return;
      }

      const scale = this.viewport.scale || 1;
      const deltaX = (event.clientX - this.nodeResizeState.startClientX) / scale;
      const deltaY = (event.clientY - this.nodeResizeState.startClientY) / scale;

      if (!this.nodeResizeState.didResize && Math.hypot(deltaX, deltaY) < 3) {
        return;
      }

      this.nodeResizeState.didResize = true;
      const bounds = getNodeSizeBounds(positioned.node);
      this.nodeSizeOverrides[positioned.node.id] = {
        width: clamp(
          Math.round(this.nodeResizeState.startWidth + deltaX),
          bounds.minWidth,
          bounds.maxWidth,
        ),
        height: clamp(
          Math.round(this.nodeResizeState.startHeight + deltaY),
          bounds.minHeight,
          bounds.maxHeight,
        ),
      };
      this.render();
      return;
    }

    if (this.associationLabelDragState && event.pointerId === this.associationLabelDragState.pointerId) {
      const scale = this.viewport.scale || 1;
      const deltaX = (event.clientX - this.associationLabelDragState.startClientX) / scale;
      const deltaY = (event.clientY - this.associationLabelDragState.startClientY) / scale;

      if (!this.associationLabelDragState.didDrag && Math.hypot(deltaX, deltaY) < 3) {
        return;
      }

      this.associationLabelDragState.didDrag = true;
      const association = this.associations.find(
        (item) => item.id === this.associationLabelDragState?.associationId,
      );
      if (!association) {
        return;
      }

      association.labelOffset = {
        x: this.associationLabelDragState.startOffset.x + deltaX,
        y: this.associationLabelDragState.startOffset.y + deltaY,
      };
      this.render();
      return;
    }

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
    if (this.nodeResizeState && event.pointerId === this.nodeResizeState.pointerId) {
      const resizeState = this.nodeResizeState;
      this.nodeResizeState = null;
      if (this.elements?.surface.hasPointerCapture(event.pointerId)) {
        this.elements.surface.releasePointerCapture(event.pointerId);
      }

      if (resizeState.didResize) {
        this.pendingEditOnClickNodeId = null;
        this.suppressNextNodeClick = true;
        void this.persistNodeResize(resizeState);
      } else {
        this.render();
      }
      return;
    }

    if (
      this.associationLabelDragState &&
      event.pointerId === this.associationLabelDragState.pointerId
    ) {
      const dragState = this.associationLabelDragState;
      this.associationLabelDragState = null;
      if (this.elements?.surface.hasPointerCapture(event.pointerId)) {
        this.elements.surface.releasePointerCapture(event.pointerId);
      }

      if (dragState.didDrag) {
        void this.persistAssociationLabelDrag(dragState);
      } else {
        this.render();
      }
      return;
    }

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
        this.pendingEditOnClickNodeId = null;
        this.suppressNextNodeClick = true;
        if (dropPreview) {
          void this.applyDragMove(anchorNodeId, dropPreview, beforeLayout);
        } else if (this.file) {
          void this.persistLayoutDrag(anchorNodeId, beforeLayout);
        }
      } else if (this.pendingEditOnClickNodeId === anchorNodeId) {
        this.render();
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
    if (!undo || !undo.showBanner || this.undoBarDismissed) {
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

  private async applyMarkdownTextOperation(
    buildOperation: (
      sourceRef: SourceDocumentRef,
      content: string,
    ) => MarkdownTextOperationResult,
  ): Promise<void> {
    if (!this.file) {
      return;
    }

    const sourceRef = this.getSourceDocumentRef();
    if (!sourceRef) {
      return;
    }

    this.isApplyingLocalChange = true;

    try {
      const content = await this.app.vault.read(this.file);
      const operation = buildOperation(sourceRef, content);
      const beforeAssociations = cloneAssociations(this.associations);
      const nextParsed = parseMarkdownToMindMap(sourceRef, operation.content);
      const nextAssociations = reconcileAssociations(nextParsed, beforeAssociations).associations;
      this.pendingSelection = operation.nextSelection
        ? {
            source: operation.nextSelection,
          }
        : null;

      if (!associationsEqual(beforeAssociations, nextAssociations)) {
        this.associations = cloneAssociations(nextAssociations);
        await this.plugin.setAssociationsForFile(this.file.path, nextAssociations);
      }

      if (operation.content !== content) {
        const beforeLayout = cloneLayoutOffsets(this.nodeLayoutOffsets);
        const beforeNodeSizes = cloneNodeSizes(this.nodeSizeOverrides);
        const afterLayout = operation.preserveLayout
          ? cloneLayoutOffsets(this.nodeLayoutOffsets)
          : {};
        const afterNodeSizes = operation.preserveLayout
          ? cloneNodeSizes(this.nodeSizeOverrides)
          : {};

        await this.app.vault.modify(this.file, operation.content);

        if (!operation.preserveLayout) {
          this.nodeLayoutOffsets = {};
          this.nodeSizeOverrides = {};
          await this.plugin.setLayoutForFile(this.file.path, {});
          await this.plugin.setNodeSizesForFile(this.file.path, {});
        }

        this.pushUndoEntry({
          filePath: this.file.path,
          label: operation.label,
          showBanner: operation.showBanner,
          beforeContent: content,
          afterContent: operation.content,
          beforeLayout,
          afterLayout,
          beforeNodeSizes,
          afterNodeSizes,
          beforeAssociations,
          afterAssociations: nextAssociations,
          restoreSelectionNodeId: operation.restoreSelectionNodeId,
        });
      } else if (!associationsEqual(beforeAssociations, nextAssociations)) {
        const currentLayout = cloneLayoutOffsets(this.nodeLayoutOffsets);
        const currentNodeSizes = cloneNodeSizes(this.nodeSizeOverrides);
        this.pushUndoEntry({
          filePath: this.file.path,
          label: operation.label,
          showBanner: operation.showBanner,
          beforeContent: content,
          afterContent: content,
          beforeLayout: currentLayout,
          afterLayout: currentLayout,
          beforeNodeSizes: currentNodeSizes,
          afterNodeSizes: currentNodeSizes,
          beforeAssociations,
          afterAssociations: nextAssociations,
          restoreSelectionNodeId: operation.restoreSelectionNodeId,
        });
      }

      await this.refresh();
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

  private openNodeContextMenu(event: MouseEvent, node: MindMapNode): void {
    const menu = new Menu();
    const hasSource = node.source.kind === "virtual-root" || !!node.source.span;

    if (node.source.kind !== "virtual-root") {
      menu.addItem((item) => {
        item
          .setTitle(
            this.pendingAssociationSourceNodeId === node.id
              ? "Cancel relationship"
              : "Start relationship",
          )
          .setIcon("git-merge")
          .onClick(() => {
            if (this.pendingAssociationSourceNodeId === node.id) {
              this.pendingAssociationSourceNodeId = null;
              this.render();
              return;
            }

            this.selectedNodeId = node.id;
            this.startRelationshipFromSelectedNode();
          });
      });

      const nodeAssociationCount = this.associations.filter(
        (association) => association.from.nodeId === node.id || association.to.nodeId === node.id,
      ).length;
      if (nodeAssociationCount > 0) {
        menu.addItem((item) => {
          item
            .setTitle(
              nodeAssociationCount === 1
                ? "Delete related association"
                : `Delete ${nodeAssociationCount} related associations`,
            )
            .setIcon("trash")
            .onClick(() => {
              void this.deleteAssociationsForNode(node.id);
            });
        });
      }

      if (
        this.pendingAssociationSourceNodeId &&
        this.pendingAssociationSourceNodeId !== node.id
      ) {
        menu.addItem((item) => {
          item
            .setTitle("Create relationship to this topic")
            .setIcon("plus")
            .onClick(() => {
              void this.createAssociation(this.pendingAssociationSourceNodeId!, node.id);
            });
        });
      }
    }

    menu.addItem((item) => {
      item
        .setTitle(
          node.source.kind === "virtual-root"
            ? "Jump to note start"
            : "Jump to Markdown source",
        )
        .setIcon("arrow-up-right")
        .setDisabled(!hasSource)
        .onClick(() => {
          void this.jumpToNodeSource(node);
        });
    });

    menu.showAtMouseEvent(event);
  }

  private openAssociationContextMenu(event: MouseEvent, association: MindMapAssociation): void {
    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle("Edit relationship text")
        .setIcon("pencil")
        .onClick(() => {
          this.startEditingAssociation(association.id);
        });
    });

    if (association.labelOffset && (association.labelOffset.x !== 0 || association.labelOffset.y !== 0)) {
      menu.addItem((item) => {
        item
          .setTitle("Reset relationship layout")
          .setIcon("rotate-ccw")
          .onClick(() => {
            void this.resetAssociationLabelOffset(association.id);
          });
      });
    }

    menu.addItem((item) => {
      item
        .setTitle("Delete relationship")
        .setIcon("trash")
        .onClick(() => {
          void this.deleteAssociation(association.id);
        });
    });

    menu.showAtMouseEvent(event);
  }

  private getRenderedAssociations(layout: MindMapLayout): RenderedAssociation[] {
    if (!this.parsed || !this.file) {
      return [];
    }

    const rendered: RenderedAssociation[] = [];
    for (const association of this.associations) {
      const fromNode = this.parsed.nodesById.get(association.from.nodeId) ?? null;
      const toNode = this.parsed.nodesById.get(association.to.nodeId) ?? null;
      if (!fromNode || !toNode || fromNode.id === toNode.id) {
        continue;
      }

      const fromPositioned = layout.nodes.get(fromNode.id);
      const toPositioned = layout.nodes.get(toNode.id);
      if (!fromPositioned || !toPositioned) {
        continue;
      }

      const geometry = buildAssociationGeometry(
        fromPositioned,
        toPositioned,
        association.labelOffset,
      );

      rendered.push({
        association,
        fromNode,
        toNode,
        path: geometry.path,
        labelX: geometry.labelX,
        labelY: geometry.labelY,
      });
    }

    return rendered;
  }

  private async createAssociation(fromNodeId: string, toNodeId: string): Promise<void> {
    if (!this.file || !this.parsed || fromNodeId === toNodeId) {
      this.pendingAssociationSourceNodeId = null;
      this.render();
      return;
    }

    const from = buildAssociationEndpoint(this.parsed, fromNodeId);
    const to = buildAssociationEndpoint(this.parsed, toNodeId);
    if (!from || !to) {
      this.pendingAssociationSourceNodeId = null;
      this.render();
      return;
    }

    const existing = this.associations.some(
      (association) =>
        (association.from.nodeId === from.nodeId && association.to.nodeId === to.nodeId) ||
        (association.from.nodeId === to.nodeId && association.to.nodeId === from.nodeId),
    );
    if (existing) {
      this.pendingAssociationSourceNodeId = null;
      this.selectedAssociationId = null;
      this.selectedNodeId = to.nodeId;
      this.render();
      new Notice("These topics are already related.");
      return;
    }

    const beforeAssociations = cloneAssociations(this.associations);
    const nextAssociations = cloneAssociations(this.associations);
    nextAssociations.push({
      id: createAssociationId(),
      from,
      to,
    });

    const reconciled = reconcileAssociations(this.parsed, nextAssociations).associations;
    const content = await this.app.vault.read(this.file);
    await this.plugin.setAssociationsForFile(this.file.path, reconciled);
    this.associations = cloneAssociations(reconciled);
    this.pendingAssociationSourceNodeId = null;
    this.selectedAssociationId = reconciled[reconciled.length - 1]?.id ?? null;
    this.selectedNodeId = null;
    this.pushUndoEntry({
      filePath: this.file.path,
      label: "Created relationship",
      showBanner: false,
      beforeContent: content,
      afterContent: content,
      beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      afterLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      beforeAssociations,
      afterAssociations: reconciled,
      restoreSelectionNodeId: fromNodeId,
    });
    this.render();
  }

  private async deleteAssociation(associationId: string): Promise<void> {
    if (!this.file) {
      return;
    }

    const beforeAssociations = cloneAssociations(this.associations);
    const nextAssociations = beforeAssociations.filter(
      (association) => association.id !== associationId,
    );
    if (nextAssociations.length === beforeAssociations.length) {
      return;
    }

    const content = await this.app.vault.read(this.file);
    await this.plugin.setAssociationsForFile(this.file.path, nextAssociations);
    this.associations = cloneAssociations(nextAssociations);
    this.selectedAssociationId = null;
    this.pushUndoEntry({
      filePath: this.file.path,
      label: "Deleted relationship",
      showBanner: false,
      beforeContent: content,
      afterContent: content,
      beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      afterLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      beforeAssociations,
      afterAssociations: nextAssociations,
      restoreSelectionNodeId: this.selectedNodeId,
    });
    this.render();
  }

  private async resetAssociationLabelOffset(associationId: string): Promise<void> {
    if (!this.file) {
      return;
    }

    const beforeAssociations = cloneAssociations(this.associations);
    const nextAssociations = cloneAssociations(this.associations);
    const association = nextAssociations.find((item) => item.id === associationId);
    if (!association || !association.labelOffset) {
      return;
    }

    association.labelOffset = undefined;
    if (associationsEqual(beforeAssociations, nextAssociations)) {
      return;
    }

    const content = await this.app.vault.read(this.file);
    await this.plugin.setAssociationsForFile(this.file.path, nextAssociations);
    this.associations = cloneAssociations(nextAssociations);
    this.selectedAssociationId = associationId;
    this.pushUndoEntry({
      filePath: this.file.path,
      label: "Reset relationship layout",
      showBanner: false,
      beforeContent: content,
      afterContent: content,
      beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      afterLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      beforeAssociations,
      afterAssociations: nextAssociations,
      restoreSelectionNodeId: null,
    });
    this.render();
  }

  private async deleteAssociationsForNode(nodeId: string): Promise<void> {
    if (!this.file) {
      return;
    }

    const beforeAssociations = cloneAssociations(this.associations);
    const nextAssociations = beforeAssociations.filter(
      (association) => association.from.nodeId !== nodeId && association.to.nodeId !== nodeId,
    );
    if (nextAssociations.length === beforeAssociations.length) {
      return;
    }

    const content = await this.app.vault.read(this.file);
    await this.plugin.setAssociationsForFile(this.file.path, nextAssociations);
    this.associations = cloneAssociations(nextAssociations);
    this.selectedAssociationId = null;
    this.pushUndoEntry({
      filePath: this.file.path,
      label: "Deleted related relationships",
      showBanner: false,
      beforeContent: content,
      afterContent: content,
      beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      afterLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
      beforeAssociations,
      afterAssociations: nextAssociations,
      restoreSelectionNodeId: nodeId,
    });
    this.render();
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
      if (
        dragged.has(candidate.id) ||
        candidate.source.kind === "linked-note" ||
        candidate.source.kind === "image-embed"
      ) {
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
    if (!this.file) {
      return;
    }

    this.isApplyingLocalChange = true;

    try {
      await this.applyMarkdownTextOperation((sourceRef, content) =>
        moveNodeInMarkdown(
          sourceRef,
          content,
          anchorNodeId,
          dropPreview.targetNodeId,
          dropPreview.position,
        ),
      );
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
        showBanner: false,
        beforeContent: content,
        afterContent: content,
        beforeLayout,
        afterLayout,
        beforeNodeSizes: cloneNodeSizes(this.nodeSizeOverrides),
        afterNodeSizes: cloneNodeSizes(this.nodeSizeOverrides),
        beforeAssociations: cloneAssociations(this.associations),
        afterAssociations: cloneAssociations(this.associations),
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

  private async persistNodeResize(resizeState: NodeResizeState): Promise<void> {
    if (!this.file) {
      return;
    }

    const afterNodeSizes = cloneNodeSizes(this.nodeSizeOverrides);
    if (nodeSizesEqual(resizeState.beforeNodeSizes, afterNodeSizes)) {
      this.render();
      return;
    }

    this.isApplyingLocalChange = true;
    try {
      const content = await this.app.vault.read(this.file);
      await this.plugin.setNodeSizesForFile(this.file.path, afterNodeSizes);
      this.pushUndoEntry({
        filePath: this.file.path,
        label: "Resized topic",
        showBanner: false,
        beforeContent: content,
        afterContent: content,
        beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
        afterLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
        beforeNodeSizes: resizeState.beforeNodeSizes,
        afterNodeSizes,
        beforeAssociations: cloneAssociations(this.associations),
        afterAssociations: cloneAssociations(this.associations),
        restoreSelectionNodeId: resizeState.nodeId,
      });
      this.render();
    } catch {
      this.nodeSizeOverrides = cloneNodeSizes(resizeState.beforeNodeSizes);
      this.render();
      new Notice("Failed to save the topic size.");
    } finally {
      this.isApplyingLocalChange = false;
    }
  }

  private async persistAssociationLabelDrag(
    dragState: AssociationLabelDragState,
  ): Promise<void> {
    if (!this.file) {
      return;
    }

    const afterAssociations = cloneAssociations(this.associations);
    if (associationsEqual(dragState.beforeAssociations, afterAssociations)) {
      this.render();
      return;
    }

    this.isApplyingLocalChange = true;
    try {
      const content = await this.app.vault.read(this.file);
      await this.plugin.setAssociationsForFile(this.file.path, afterAssociations);
      this.pushUndoEntry({
        filePath: this.file.path,
        label: "Moved relationship label",
        showBanner: false,
        beforeContent: content,
        afterContent: content,
        beforeLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
        afterLayout: cloneLayoutOffsets(this.nodeLayoutOffsets),
        beforeAssociations: dragState.beforeAssociations,
        afterAssociations,
        restoreSelectionNodeId: null,
      });
      this.selectedAssociationId = dragState.associationId;
      this.render();
    } catch {
      this.associations = cloneAssociations(dragState.beforeAssociations);
      this.render();
      new Notice("Failed to save the relationship layout.");
    } finally {
      this.isApplyingLocalChange = false;
    }
  }

  private pushUndoEntry(entry: UndoHistoryEntry): void {
    const beforeNodeSizes = cloneNodeSizes(entry.beforeNodeSizes ?? this.nodeSizeOverrides);
    const afterNodeSizes = cloneNodeSizes(entry.afterNodeSizes ?? this.nodeSizeOverrides);
    this.undoHistory.push({
      ...entry,
      beforeLayout: cloneLayoutOffsets(entry.beforeLayout),
      afterLayout: cloneLayoutOffsets(entry.afterLayout),
      beforeNodeSizes,
      afterNodeSizes,
      beforeAssociations: cloneAssociations(entry.beforeAssociations),
      afterAssociations: cloneAssociations(entry.afterAssociations),
    });
    if (this.undoHistory.length > 50) {
      this.undoHistory.shift();
    }
    this.undoBarDismissed = !entry.showBanner;
    this.clearUndoBarTimeout();
    if (entry.showBanner) {
      this.undoBarTimeout = window.setTimeout(() => {
        this.undoBarDismissed = true;
        this.undoBarTimeout = null;
        this.renderUndoBar();
      }, 3200);
    }
    this.renderUndoBar();
  }

  private clearUndoBarTimeout(): void {
    if (this.undoBarTimeout != null) {
      window.clearTimeout(this.undoBarTimeout);
      this.undoBarTimeout = null;
    }
  }

  private hasTextInputFocus(): boolean {
    const activeElement = document.activeElement;
    if (!activeElement) {
      return false;
    }

    return (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement ||
      (activeElement instanceof HTMLElement && activeElement.isContentEditable)
    );
  }

  private isActiveMindMapView(): boolean {
    return this.app.workspace.getActiveViewOfType(MindMapView) === this;
  }

  private async writeClipboardPreview(copied: CopiedMindMapSubtree): Promise<void> {
    if (!navigator.clipboard?.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(copied.lines.join("\n"));
    } catch {
      // Ignore clipboard permission failures; the in-plugin clipboard remains available.
    }
  }

  private async readClipboardText(): Promise<string> {
    if (!navigator.clipboard?.readText) {
      return "";
    }

    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }

  private resolveImageSource(target: string): string | null {
    const normalizedTarget = target.trim();
    if (normalizedTarget.length === 0) {
      return null;
    }

    if (/^(https?:|data:|blob:)/i.test(normalizedTarget)) {
      return normalizedTarget;
    }

    if (!this.file) {
      return null;
    }

    const fromMetadata = this.app.metadataCache.getFirstLinkpathDest(
      normalizedTarget,
      this.file.path,
    );
    if (fromMetadata) {
      return this.app.vault.getResourcePath(fromMetadata);
    }

    const resolvedPath = normalizedTarget.startsWith("/")
      ? normalizePath(normalizedTarget.slice(1))
      : normalizePath(
          this.file.parent?.path
            ? `${this.file.parent.path}/${normalizedTarget}`
            : normalizedTarget,
        );

    const abstractFile = this.app.vault.getAbstractFileByPath(resolvedPath);
    if (abstractFile instanceof TFile) {
      return this.app.vault.getResourcePath(abstractFile);
    }

    return null;
  }

  private startDirectTypingEdit(
    kind: PendingTypingStart["kind"],
    id: string,
    seedText: string,
  ): void {
    this.clearPendingTypingStart();

    if (kind === "association") {
      this.startEditingAssociation(id, "");
    } else {
      this.startEditing(id, "");
    }

    const timeoutId = window.setTimeout(() => {
      const pending = this.pendingTypingStart;
      this.pendingTypingStart = null;
      if (!pending || pending.id !== id || pending.kind !== kind) {
        return;
      }

      const targetStillEditing =
        kind === "association"
          ? this.editingAssociationId === id
          : this.editingNodeId === id;
      if (!targetStillEditing || !this.editorInput || this.isEditorComposing) {
        return;
      }

      if (this.editorInput.value.length > 0) {
        return;
      }

      this.editorInput.value = seedText;
      const end = this.editorInput.value.length;
      this.editorInput.setSelectionRange(end, end);
    }, DIRECT_TYPING_SEED_DELAY_MS);

    this.pendingTypingStart = {
      kind,
      id,
      seedText,
      timeoutId,
    };
  }

  private handleEditorInput(): void {
    if (!this.pendingTypingStart || !this.editorInput || this.isEditorComposing) {
      return;
    }

    const pending = this.pendingTypingStart;
    const targetStillEditing =
      pending.kind === "association"
        ? this.editingAssociationId === pending.id
        : this.editingNodeId === pending.id;
    if (!targetStillEditing) {
      this.clearPendingTypingStart();
      return;
    }

    if (this.editorInput.value.length === 0) {
      return;
    }

    this.editorInput.value = applyPendingTypingSeed(pending.seedText, this.editorInput.value);
    const end = this.editorInput.value.length;
    this.editorInput.setSelectionRange(end, end);
    this.clearPendingTypingStart();
  }

  private clearPendingTypingStart(): void {
    if (!this.pendingTypingStart) {
      return;
    }

    window.clearTimeout(this.pendingTypingStart.timeoutId);
    this.pendingTypingStart = null;
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
    return node.source.kind !== "linked-note" && node.source.kind !== "image-embed";
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

function buildAssociationGeometry(
  from: PositionedMindMapNode,
  to: PositionedMindMapNode,
  offset?: NodeLayoutOffset,
): { path: string; labelX: number; labelY: number } {
  const fromCenterX = from.x + from.width / 2;
  const fromCenterY = from.y + from.height / 2;
  const toCenterX = to.x + to.width / 2;
  const toCenterY = to.y + to.height / 2;

  let startX = from.x + from.width;
  let startY = fromCenterY;
  let endX = to.x;
  let endY = toCenterY;

  if (to.x + to.width < from.x) {
    startX = from.x;
    endX = to.x + to.width;
  } else if (
    Math.abs(fromCenterX - toCenterX) < Math.max(from.width, to.width) * 0.55
  ) {
    const fromBelow = fromCenterY <= toCenterY;
    startX = fromCenterX;
    endX = toCenterX;
    startY = fromBelow ? from.y + from.height : from.y;
    endY = fromBelow ? to.y : to.y + to.height;
  }

  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const controlX = Math.max(36, Math.abs(deltaX) * 0.34);
  const controlY = Math.max(18, Math.abs(deltaY) * 0.22);
  const labelX = (startX + endX) / 2 + (offset?.x ?? 0);
  const labelY = (startY + endY) / 2 + (offset?.y ?? 0);

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    const direction = deltaX >= 0 ? 1 : -1;
    return {
      path: `M ${startX} ${startY} C ${startX + controlX * direction} ${startY}, ${endX - controlX * direction} ${endY}, ${endX} ${endY}`,
      labelX,
      labelY,
    };
  }

  const verticalDirection = deltaY >= 0 ? 1 : -1;
  return {
    path: `M ${startX} ${startY} C ${startX} ${startY + controlY * verticalDirection}, ${endX} ${endY - controlY * verticalDirection}, ${endX} ${endY}`,
    labelX,
    labelY,
  };
}

function shouldStartTypingEdit(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }

  if (event.isComposing || event.key === "Process" || event.key === "Dead") {
    return false;
  }

  if (event.key === " " || event.key.length === 1) {
    return true;
  }

  return false;
}

function normalizePastedTopicText(value: string): string {
  return value
    .split(/\r?\n/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAssociationLabel(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getNodeSizeBounds(
  node: MindMapNode,
): { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number } {
  if (node.source.kind === "image-embed") {
    return {
      minWidth: 160,
      minHeight: 120,
      maxWidth: 920,
      maxHeight: 680,
    };
  }

  return {
    minWidth: 120,
    minHeight: 44,
    maxWidth: 920,
    maxHeight: 680,
  };
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

function cloneNodeSizes(
  sizes: Record<string, NodeSizeOverride>,
): Record<string, NodeSizeOverride> {
  const clone: Record<string, NodeSizeOverride> = {};
  for (const [nodeId, size] of Object.entries(sizes)) {
    clone[nodeId] = {
      width: size.width,
      height: size.height,
    };
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

function nodeSizesEqual(
  left: Record<string, NodeSizeOverride>,
  right: Record<string, NodeSizeOverride>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (const [nodeId, leftSize] of leftEntries) {
    const rightSize = right[nodeId];
    if (
      !rightSize ||
      leftSize.width !== rightSize.width ||
      leftSize.height !== rightSize.height
    ) {
      return false;
    }
  }

  return true;
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
