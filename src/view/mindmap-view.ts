import {
  ItemView,
  Notice,
  TFile,
  WorkspaceLeaf,
  getLinkpath,
} from "obsidian";
import { DEFAULT_VIEWPORT, MAX_SCALE, MIN_SCALE, VIEW_NAME, VIEW_TYPE } from "../constants";
import { layoutMindMap } from "../layout/tree-layout";
import { parseMarkdownToMindMap } from "../parser/markdown-parser";
import type {
  MindMapDocument,
  MindMapInlineToken,
  MindMapNode,
  MindMapViewState,
  PositionedMindMapNode,
} from "../types";
import { TitlePatchError, patchNodeTitle } from "../write/title-patch-writer";
import type ObsidianXMindPlugin from "../main";

const SVG_NS = "http://www.w3.org/2000/svg";

interface ViewElements {
  toolbarTitle: HTMLElement;
  surface: HTMLElement;
  stage: HTMLElement;
  svg: SVGSVGElement;
  nodes: HTMLElement;
}

export class MindMapView extends ItemView {
  private plugin: ObsidianXMindPlugin;
  private file: TFile | null = null;
  private parsed: MindMapDocument | null = null;
  private elements: ViewElements | null = null;
  private selectedNodeId: string | null = null;
  private editingNodeId: string | null = null;
  private editorInput: HTMLInputElement | null = null;
  private isCommittingEdit = false;
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

  async refresh(): Promise<void> {
    if (!this.file) {
      this.parsed = null;
      this.selectedNodeId = null;
      this.endEditing(false);
      this.render();
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

    this.parsed = parsed;
    this.endEditing(false);
    if (!this.selectedNodeId || !parsed.nodesById.has(this.selectedNodeId)) {
      this.selectedNodeId = parsed.root.id;
    }
    this.render();
  }

  async editSelectedNode(): Promise<void> {
    if (!this.selectedNodeId) {
      return;
    }
    this.startEditing(this.selectedNodeId);
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

    this.contentEl.append(toolbar, surface);
    this.elements = {
      toolbarTitle,
      surface,
      stage,
      svg,
      nodes,
    };
    this.applyViewport();
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
      stage.style.width = "0px";
      stage.style.height = "0px";
      return;
    }

    const layout = layoutMindMap(this.parsed.root);
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

    for (const positioned of layout.nodes.values()) {
      const elements = this.renderNode(positioned);
      nodes.append(...elements);
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
    nodeEl.addEventListener("click", (event) => {
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
    if (!node || node.source.kind === "virtual-root") {
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
    button.style.left = `${positioned.x + positioned.width + 10}px`;
    button.style.top = `${positioned.y + positioned.height / 2 - 12}px`;

    if (node.collapsed) {
      button.classList.add("is-collapsed");
      button.textContent = `${countDescendants(node)}`;
      button.title = `Expand ${countDescendants(node)} hidden nodes`;
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

  private async commitEditing(): Promise<void> {
    if (!this.file || !this.parsed || !this.editingNodeId || !this.editorInput) {
      return;
    }

    if (this.isCommittingEdit) {
      return;
    }

    this.isCommittingEdit = true;
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

    if (event.key === "Enter" && this.selectedNodeId) {
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
    if (!this.panState || event.pointerId !== this.panState.pointerId) {
      return;
    }

    this.viewport.x = this.panState.originX + (event.clientX - this.panState.startX);
    this.viewport.y = this.panState.originY + (event.clientY - this.panState.startY);
    this.applyViewport();
  }

  private onPointerUp(event: PointerEvent): void {
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
