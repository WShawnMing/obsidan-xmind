import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE } from "./constants";
import type { MindMapViewState } from "./types";
import { MindMapView } from "./view/mindmap-view";

export default class ObsidianXMindPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE,
      (leaf) => new MindMapView(leaf, this),
    );

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

  private findLeafForFile(filePath: string): WorkspaceLeaf | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MindMapView && view.isDisplayingFile(filePath)) {
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
}
