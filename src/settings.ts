import { PluginSettingTab, Setting } from "obsidian";
import type ObsidianXMindPlugin from "./main";
import type {
  AppearanceSettings,
  MindMapBackgroundStyle,
  MindMapConnectionStyle,
  MindMapNodeShape,
} from "./types";

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  backgroundStyle: "plain",
  nodeShape: "pill",
  connectionStyle: "curved",
};

export class ObsidianXMindSettingTab extends PluginSettingTab {
  private plugin: ObsidianXMindPlugin;

  constructor(plugin: ObsidianXMindPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian XMind" });

    new Setting(containerEl)
      .setName("Background")
      .setDesc("Choose the canvas background style.")
      .addDropdown((dropdown) => {
        addOptions(dropdown, {
          plain: "Plain",
          grid: "Grid",
          dots: "Dots",
          aurora: "Aurora",
        });
        dropdown.setValue(this.plugin.getAppearanceSettings().backgroundStyle);
        dropdown.onChange(async (value) => {
          await this.plugin.updateAppearanceSettings({
            backgroundStyle: value as MindMapBackgroundStyle,
          });
        });
      });

    new Setting(containerEl)
      .setName("Node Shape")
      .setDesc("Adjust the visual shape of topic nodes.")
      .addDropdown((dropdown) => {
        addOptions(dropdown, {
          pill: "Pill",
          rounded: "Rounded",
          "soft-square": "Soft square",
        });
        dropdown.setValue(this.plugin.getAppearanceSettings().nodeShape);
        dropdown.onChange(async (value) => {
          await this.plugin.updateAppearanceSettings({
            nodeShape: value as MindMapNodeShape,
          });
        });
      });

    new Setting(containerEl)
      .setName("Connection Shape")
      .setDesc("Choose how branches connect between nodes.")
      .addDropdown((dropdown) => {
        addOptions(dropdown, {
          curved: "Curved",
          angled: "Angled",
          straight: "Straight",
        });
        dropdown.setValue(this.plugin.getAppearanceSettings().connectionStyle);
        dropdown.onChange(async (value) => {
          await this.plugin.updateAppearanceSettings({
            connectionStyle: value as MindMapConnectionStyle,
          });
        });
      });
  }
}

function addOptions(
  dropdown: {
    addOption(value: string, label: string): unknown;
  },
  options: Record<string, string>,
): void {
  for (const [value, label] of Object.entries(options)) {
    dropdown.addOption(value, label);
  }
}
