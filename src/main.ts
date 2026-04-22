import { MarkdownView, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE } from "./constants";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  ObsidianXMindSettingTab,
} from "./settings";
import type {
  AppearanceSettings,
  MindMapViewState,
  NodeLayoutOffset,
  PluginData,
} from "./types";
import { MindMapView } from "./view/mindmap-view";

export default class ObsidianXMindPlugin extends Plugin {
  private layoutByFile: Record<string, Record<string, NodeLayoutOffset>> = {};
  private appearanceSettings: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS };

  async onload(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.layoutByFile = normalizeLayoutStore(data?.layoutByFile);
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
        if (!view) {
          return false;
        }

        if (!checking) {
          void view.deleteSelectedNode();
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
      hotkeys: [
        {
          modifiers: ["Mod"],
          key: "z",
        },
      ],
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

  getAppearanceSettings(): AppearanceSettings {
    return { ...this.appearanceSettings };
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

  private async persistPluginData(): Promise<void> {
    await this.saveData({
      layoutByFile: this.layoutByFile,
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
