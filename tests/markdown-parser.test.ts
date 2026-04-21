import { describe, expect, it } from "vitest";
import { parseMarkdownToMindMap } from "../src/parser/markdown-parser";

const file = {
  path: "Notes/Plan.md",
  basename: "Plan",
};

describe("parseMarkdownToMindMap", () => {
  it("uses a single H1 as the root", () => {
    const doc = parseMarkdownToMindMap(
      file,
      "# Project\n## Scope\n### Phase 1\n",
    );

    expect(doc.root.text).toBe("Project");
    expect(doc.root.source.kind).toBe("heading");
    expect(doc.root.children[0]?.text).toBe("Scope");
    expect(doc.root.children[0]?.children[0]?.text).toBe("Phase 1");
  });

  it("falls back to a virtual root when there are multiple H1 headings", () => {
    const doc = parseMarkdownToMindMap(
      file,
      "# Alpha\n## A1\n# Beta\n## B1\n",
    );

    expect(doc.root.text).toBe("Plan");
    expect(doc.root.source.kind).toBe("virtual-root");
    expect(doc.root.children.map((node) => node.text)).toEqual(["Alpha", "Beta"]);
  });

  it("uses a virtual root when there is no H1 heading", () => {
    const doc = parseMarkdownToMindMap(
      file,
      "## Scope\n### Details\n",
    );

    expect(doc.root.text).toBe("Plan");
    expect(doc.root.children[0]?.text).toBe("Scope");
  });

  it("parses overflow list levels after H6", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "###### Level 6",
        "- Level 7",
        "  - Level 8",
        "    - Level 9",
      ].join("\n"),
    );

    const level6 = doc.root.children[0];
    expect(level6?.text).toBe("Level 6");
    expect(level6?.children[0]?.text).toBe("Level 7");
    expect(level6?.children[0]?.source.kind).toBe("overflow-list");
    expect(level6?.children[0]?.children[0]?.text).toBe("Level 8");
  });

  it("keeps parsing overflow lists when plain text appears between H6 and the list", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "###### Level 6",
        "Some supporting note",
        "- Level 7",
        "  - Level 8",
      ].join("\n"),
    );

    const level6 = doc.root.children[0];
    expect(level6?.children[0]?.text).toBe("Level 7");
    expect(level6?.children[0]?.children[0]?.text).toBe("Level 8");
  });

  it("creates linked-note children from pure wikilink lines under headings", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "## Section",
        "[[Article 1]]",
        "[[Article 2|Alias 2]]",
      ].join("\n"),
    );

    const section = doc.root.children[0];
    expect(section?.children.map((node) => node.source.kind)).toEqual([
      "linked-note",
      "linked-note",
    ]);
    expect(section?.children.map((node) => node.label)).toEqual([
      "Article 1",
      "Alias 2",
    ]);
  });

  it("creates linked-note children under overflow list items", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "###### Level 6",
        "- Level 7",
        "  [[Article 1]]",
        "  [[Article 2]]",
        "  - Level 8",
      ].join("\n"),
    );

    const level7 = doc.root.children[0]?.children[0];
    expect(level7?.children.map((node) => node.label)).toEqual([
      "Article 1",
      "Article 2",
      "Level 8",
    ]);
  });

  it("records source spans for linked-note nodes", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "## Section",
        "  [[Article 1]]",
      ].join("\n"),
    );

    const linked = doc.root.children[0]?.children[0];
    expect(linked?.source.kind).toBe("linked-note");
    expect(linked?.source.span?.line).toBe(3);
    expect(linked?.source.span?.kind).toBe("linked-note");
  });

  it("ignores ordinary lists when they are not overflow nodes", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "## Section",
        "- Regular list item",
        "  - Still regular",
      ].join("\n"),
    );

    expect(doc.root.children[0]?.text).toBe("Section");
    expect(doc.root.children[0]?.children).toHaveLength(0);
  });
});
