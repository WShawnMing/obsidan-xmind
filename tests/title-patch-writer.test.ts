import { describe, expect, it } from "vitest";
import { parseMarkdownToMindMap } from "../src/parser/markdown-parser";
import { TitlePatchError, patchNodeTitle } from "../src/write/title-patch-writer";

const file = {
  path: "Notes/Plan.md",
  basename: "Plan",
};

describe("patchNodeTitle", () => {
  it("updates only the heading text span", () => {
    const source = "# Root\n## Scope\nParagraph stays.\n";
    const doc = parseMarkdownToMindMap(file, source);
    const section = doc.root.children[0];

    expect(section).toBeDefined();

    const next = patchNodeTitle(source, section!, "New Scope");
    expect(next).toBe("# Root\n## New Scope\nParagraph stays.\n");
  });

  it("updates overflow list titles without rewriting nested children", () => {
    const source = [
      "# Root",
      "###### Level 6",
      "- Level 7",
      "  - Level 8",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const overflow = doc.root.children[0]?.children[0];

    expect(overflow).toBeDefined();

    const next = patchNodeTitle(source, overflow!, "Renamed 7");
    expect(next).toBe([
      "# Root",
      "###### Level 6",
      "- Renamed 7",
      "  - Level 8",
    ].join("\n"));
  });

  it("rejects stale spans when the note changed externally", () => {
    const source = "# Root\n## Scope\n";
    const doc = parseMarkdownToMindMap(file, source);
    const section = doc.root.children[0];

    expect(() =>
      patchNodeTitle("# Root\n## Changed elsewhere\n", section!, "New Scope"),
    ).toThrowError(TitlePatchError);
  });
});
