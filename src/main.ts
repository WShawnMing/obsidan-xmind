import { MarkdownView, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE } from "./constants";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  ObsidianXMindSettingTab,
} from "./settings";
import type {
  AppearanceSettings,
  MindMapAssociation,
  MindMapViewState,
  NodeLayoutOffset,
  PluginData,
} from "./types";
import { MindMapView } from "./view/mindmap-view";
import type { CopiedMindMapSubtree } from "./write/structure-patch-writer";

export default class ObsidianXMindPlugin extends Plugin {
  private layoutByFile: Record<string, Record<string, NodeLayoutOffset>> = {};
  private associationsByFile: Record<string, MindMapAssociation[]> = {};
  private appearanceSettings: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS };
  private mindMapClipboard: CopiedMindMapSubtree | null = null;

  async onload(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.layoutByFile = normalizeLayoutStore(data?.layoutByFile);
    this.associationsByFile = normalizeAssociationStore(data?.associationsByFile);
    this.appearanceSettings = normalizeAppearanceSettings(data?.appearance);

    this.registerView(
      VIEW_TYPE,
      (leaf) => new MindMapView(leaf, this),
    );
    this.addSettingTab(new ObsidianXMindSettingTab(this));

    this.addCommand({
      id: "open-mind-map-for-current-note",
      name: "Open mind map for current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!this.isMarkdownFile(file)) {
          return false;
        }

        if (!checking) {
          void this.openMindMapForFile(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "refresh-current-mind-map",
      name: "Refresh current mind map",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view) {
          return false;
        }

        if (!checking) {
          void view.refresh();
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-add-sibling-topic",
      name: "Mind map: Add sibling topic",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view) {
          return false;
        }

        if (!checking) {
          void view.addSiblingNode();
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-add-child-topic",
      name: "Mind map: Add child topic",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view) {
          return false;
        }

        if (!checking) {
          void view.addChildNode();
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-delete-selected-topic",
      name: "Mind map: Delete selected topic",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canDeleteSelectedNode()) {
          return false;
        }

        if (!checking) {
          void view.deleteSelectedNode();
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-select-topic-left",
      name: "Mind map: Select topic to the left",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canNavigateSelection()) {
          return false;
        }

        if (!checking) {
          view.navigateSelection("left");
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-select-topic-right",
      name: "Mind map: Select topic to the right",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canNavigateSelection()) {
          return false;
        }

        if (!checking) {
          view.navigateSelection("right");
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-select-topic-up",
      name: "Mind map: Select topic above",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canNavigateSelection()) {
          return false;
        }

        if (!checking) {
          view.navigateSelection("up");
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-select-topic-down",
      name: "Mind map: Select topic below",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canNavigateSelection()) {
          return false;
        }

        if (!checking) {
          view.navigateSelection("down");
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-edit-selected-topic",
      name: "Mind map: Edit selected topic",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view) {
          return false;
        }

        if (!checking) {
          void view.editSelectedNode();
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-undo-last-action",
      name: "Mind map: Undo last action",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canUndoLastAction()) {
          return false;
        }

        if (!checking) {
          void view.undoLastAction();
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-copy-selected-topic",
      name: "Mind map: Copy selected topic",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canCopySelectedNode()) {
          return false;
        }

        if (!checking) {
          void view.copySelectedNode();
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-paste-after-selected-topic",
      name: "Mind map: Paste after selected topic",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canPasteAfterSelectedNode()) {
          return false;
        }

        if (!checking) {
          void view.pasteAfterSelectedNode();
        }
        return true;
      },
    });

    this.addCommand({
      id: "mind-map-start-relationship-from-selected-topic",
      name: "Mind map: Start relationship from selected topic",
      checkCallback: (checking) => {
        const view = this.getActiveMindMapView();
        if (!view || !view.canStartRelationshipFromSelectedNode()) {
          return false;
        }

        if (!checking) {
          view.startRelationshipFromSelectedNode();
        }
        return true;
      },
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          void this.notifyViewsOfModifiedFile(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          void this.migrateLayoutBucket(oldPath, file.path);
          void this.migrateAssociationBucket(oldPath, file.path);
          void this.notifyViewsOfRenamedFile(file, oldPath);
        }
      }),
    );
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async openMindMapForFile(file: TFile): Promise<void> {
    const existingLeaf = this.findLeafForFile(file.path);
    const leaf = existingLeaf ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: {
        filePath: file.path,
      } satisfies MindMapViewState,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  getActiveMindMapView(): MindMapView | null {
    const activeLeaf = this.app.workspace.getMostRecentLeaf();
    if (!activeLeaf) {
      return null;
    }

    return activeLeaf.view instanceof MindMapView ? activeLeaf.view : null;
  }

  getLayoutForFile(filePath: string): Record<string, NodeLayoutOffset> {
    return { ...(this.layoutByFile[filePath] ?? {}) };
  }

  getAssociationsForFile(filePath: string): MindMapAssociation[] {
    return cloneAssociations(this.associationsByFile[filePath] ?? []);
  }

  getAppearanceSettings(): AppearanceSettings {
    return { ...this.appearanceSettings };
  }

  setMindMapClipboard(copied: CopiedMindMapSubtree | null): void {
    this.mindMapClipboard = copied
      ? {
          ...copied,
          lines: [...copied.lines],
        }
      : null;
  }

  getMindMapClipboard(): CopiedMindMapSubtree | null {
    return this.mindMapClipboard
      ? {
          ...this.mindMapClipboard,
          lines: [...this.mindMapClipboard.lines],
        }
      : null;
  }

  hasMindMapClipboard(): boolean {
    return !!this.mindMapClipboard;
  }

  async setLayoutForFile(
    filePath: string,
    layout: Record<string, NodeLayoutOffset>,
  ): Promise<void> {
    if (Object.keys(layout).length === 0) {
      delete this.layoutByFile[filePath];
    } else {
      this.layoutByFile[filePath] = { ...layout };
    }

    await this.persistPluginData();
  }

  async setAssociationsForFile(
    filePath: string,
    associations: MindMapAssociation[],
  ): Promise<void> {
    if (associations.length === 0) {
      delete this.associationsByFile[filePath];
    } else {
      this.associationsByFile[filePath] = cloneAssociations(associations);
    }

    await this.persistPluginData();
  }

  async updateAppearanceSettings(
    patch: Partial<AppearanceSettings>,
  ): Promise<void> {
    this.appearanceSettings = {
      ...this.appearanceSettings,
      ...patch,
    };

    await this.persistPluginData();
    await this.refreshAllMindMapViews();
  }

  async jumpToFilePosition(
    file: TFile,
    line: number,
    column: number,
  ): Promise<void> {
    const existingLeaf = this.findMarkdownLeafForFile(file.path);
    const leaf = existingLeaf ?? this.app.workspace.getLeaf(true);
    await leaf.openFile(file, {
      active: true,
      state: {
        mode: "source",
      },
    });
    this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });

    if (leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor;
      const target = {
        line: Math.max(0, line),
        ch: Math.max(0, column),
      };
      editor.setCursor(target);
      editor.scrollIntoView(
        {
          from: target,
          to: target,
        },
        true,
      );
      editor.focus();
    }
  }

  async pruneLayoutForFile(filePath: string, validNodeIds: Iterable<string>): Promise<void> {
    const current = this.layoutByFile[filePath];
    if (!current) {
      return;
    }

    const valid = new Set(validNodeIds);
    const next: Record<string, NodeLayoutOffset> = {};
    let changed = false;

    for (const [nodeId, offset] of Object.entries(current)) {
      if (valid.has(nodeId)) {
        next[nodeId] = offset;
      } else {
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    if (Object.keys(next).length === 0) {
      delete this.layoutByFile[filePath];
    } else {
      this.layoutByFile[filePath] = next;
    }

    await this.persistPluginData();
  }

  private findLeafForFile(filePath: string): WorkspaceLeaf | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MindMapView && view.isDisplayingFile(filePath)) {
        return leaf;
      }
    }

    return null;
  }

  private findMarkdownLeafForFile(filePath: string): WorkspaceLeaf | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === filePath) {
        return leaf;
      }
    }

    return null;
  }

  private async notifyViewsOfModifiedFile(file: TFile): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MindMapView && view.isDisplayingFile(file.path)) {
        await view.handleFileModified(file);
      }
    }
  }

  private async notifyViewsOfRenamedFile(file: TFile, oldPath: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (
        view instanceof MindMapView &&
        (view.isDisplayingFile(file.path) || view.isDisplayingFile(oldPath))
      ) {
        await view.handleFileRenamed(file, oldPath);
      }
    }
  }

  private isMarkdownFile(file: TFile | null): file is TFile {
    return file instanceof TFile && file.extension === "md";
  }

  private async migrateLayoutBucket(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) {
      return;
    }

    const current = this.layoutByFile[oldPath];
    if (!current) {
      return;
    }

    this.layoutByFile[newPath] = current;
    delete this.layoutByFile[oldPath];
    await this.persistPluginData();
  }

  private async migrateAssociationBucket(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) {
      return;
    }

    const current = this.associationsByFile[oldPath];
    if (!current) {
      return;
    }

    this.associationsByFile[newPath] = current;
    delete this.associationsByFile[oldPath];
    await this.persistPluginData();
  }

  private async persistPluginData(): Promise<void> {
    await this.saveData({
      layoutByFile: this.layoutByFile,
      associationsByFile: this.associationsByFile,
      appearance: this.appearanceSettings,
    } satisfies PluginData);
  }

  private async refreshAllMindMapViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MindMapView) {
        await view.handleAppearanceChanged();
      }
    }
  }
}

function normalizeLayoutStore(
  value: PluginData["layoutByFile"],
): Record<string, Record<string, NodeLayoutOffset>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const next: Record<string, Record<string, NodeLayoutOffset>> = {};

  for (const [filePath, nodeMap] of Object.entries(value)) {
    if (!nodeMap || typeof nodeMap !== "object") {
      continue;
    }

    const normalizedNodeMap: Record<string, NodeLayoutOffset> = {};
    for (const [nodeId, offset] of Object.entries(nodeMap)) {
      if (
        offset &&
        typeof offset === "object" &&
        Number.isFinite(offset.x) &&
        Number.isFinite(offset.y)
      ) {
        normalizedNodeMap[nodeId] = {
          x: offset.x,
          y: offset.y,
        };
      }
    }

    if (Object.keys(normalizedNodeMap).length > 0) {
      next[filePath] = normalizedNodeMap;
    }
  }

  return next;
}

function normalizeAppearanceSettings(
  value: PluginData["appearance"],
): AppearanceSettings {
  return {
    backgroundStyle:
      value?.backgroundStyle ?? DEFAULT_APPEARANCE_SETTINGS.backgroundStyle,
    nodeShape: value?.nodeShape ?? DEFAULT_APPEARANCE_SETTINGS.nodeShape,
    connectionStyle:
      value?.connectionStyle ?? DEFAULT_APPEARANCE_SETTINGS.connectionStyle,
  };
}

function normalizeAssociationStore(
  value: PluginData["associationsByFile"],
): Record<string, MindMapAssociation[]> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const next: Record<string, MindMapAssociation[]> = {};

  for (const [filePath, associations] of Object.entries(value)) {
    if (!Array.isArray(associations) || associations.length === 0) {
      continue;
    }

    const normalized: MindMapAssociation[] = [];
    for (const association of associations) {
      if (
        !association ||
        typeof association !== "object" ||
        typeof association.id !== "string" ||
        !isValidAssociationEndpoint(association.from) ||
        !isValidAssociationEndpoint(association.to)
      ) {
        continue;
      }

      normalized.push({
        id: association.id,
        from: {
          nodeId: association.from.nodeId,
          locator: {
            kind: association.from.locator.kind,
            text: association.from.locator.text,
            depth: association.from.locator.depth,
            ancestorTexts: [...association.from.locator.ancestorTexts],
            siblingIndex: association.from.locator.siblingIndex,
            subtreeSignature: association.from.locator.subtreeSignature,
          },
        },
        to: {
          nodeId: association.to.nodeId,
          locator: {
            kind: association.to.locator.kind,
            text: association.to.locator.text,
            depth: association.to.locator.depth,
            ancestorTexts: [...association.to.locator.ancestorTexts],
            siblingIndex: association.to.locator.siblingIndex,
            subtreeSignature: association.to.locator.subtreeSignature,
          },
        },
        label: typeof association.label === "string" ? association.label : undefined,
        labelOffset:
          association.labelOffset &&
          typeof association.labelOffset === "object" &&
          Number.isFinite(association.labelOffset.x) &&
          Number.isFinite(association.labelOffset.y)
            ? {
                x: association.labelOffset.x,
                y: association.labelOffset.y,
              }
            : undefined,
      });
    }

    if (normalized.length > 0) {
      next[filePath] = normalized;
    }
  }

  return next;
}

function cloneAssociations(
  associations: MindMapAssociation[],
): MindMapAssociation[] {
  return associations.map((association) => ({
    id: association.id,
    from: {
      nodeId: association.from.nodeId,
      locator: {
        kind: association.from.locator.kind,
        text: association.from.locator.text,
        depth: association.from.locator.depth,
        ancestorTexts: [...association.from.locator.ancestorTexts],
        siblingIndex: association.from.locator.siblingIndex,
        subtreeSignature: association.from.locator.subtreeSignature,
      },
    },
    to: {
      nodeId: association.to.nodeId,
      locator: {
        kind: association.to.locator.kind,
        text: association.to.locator.text,
        depth: association.to.locator.depth,
        ancestorTexts: [...association.to.locator.ancestorTexts],
        siblingIndex: association.to.locator.siblingIndex,
        subtreeSignature: association.to.locator.subtreeSignature,
      },
    },
    label: association.label,
    labelOffset: association.labelOffset
      ? {
          x: association.labelOffset.x,
          y: association.labelOffset.y,
        }
      : undefined,
  }));
}

function isValidAssociationEndpoint(
  value: unknown,
): value is MindMapAssociation["from"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const endpoint = value as MindMapAssociation["from"];
  return (
    typeof endpoint.nodeId === "string" &&
    !!endpoint.locator &&
    typeof endpoint.locator.kind === "string" &&
    typeof endpoint.locator.text === "string" &&
    Number.isInteger(endpoint.locator.depth) &&
    Array.isArray(endpoint.locator.ancestorTexts) &&
    endpoint.locator.ancestorTexts.every((item) => typeof item === "string") &&
    Number.isInteger(endpoint.locator.siblingIndex) &&
    typeof endpoint.locator.subtreeSignature === "string"
  );
}
