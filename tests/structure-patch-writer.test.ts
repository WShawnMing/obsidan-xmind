import { describe, expect, it } from "vitest";
import { parseMarkdownToMindMap } from "../src/parser/markdown-parser";
import {
  StructurePatchError,
  deleteNode,
  insertChildNode,
  insertSiblingNode,
} from "../src/write/structure-patch-writer";

const file = {
  path: "Notes/Plan.md",
  basename: "Plan",
};

describe("structure-patch-writer", () => {
  it("adds a sibling heading after the selected subtree", () => {
    const source = [
      "# Root",
      "## Alpha",
      "### Child",
      "## Beta",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const alpha = doc.root.children[0];

    const patch = insertSiblingNode(source, alpha!);

    expect(patch.content).toBe([
      "# Root",
      "## Alpha",
      "### Child",
      "## New topic",
      "## Beta",
    ].join("\n"));
    expect(patch.insertedNode?.line).toBe(4);
  });

  it("adds an overflow child under an H6 heading", () => {
    const source = [
      "# Root",
      "###### Level 6",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const level6 = doc.root.children[0];

    const patch = insertChildNode(source, level6!);

    expect(patch.content).toBe([
      "# Root",
      "###### Level 6",
      "- New topic",
    ].join("\n"));
    expect(patch.insertedNode).toEqual({
      kind: "overflow-list",
      depth: 7,
      line: 3,
      text: "New topic",
    });
  });

  it("adds a nested overflow child under an overflow node", () => {
    const source = [
      "# Root",
      "###### Level 6",
      "- Level 7",
      "  - Existing child",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const level7 = doc.root.children[0]?.children[0];

    const patch = insertChildNode(source, level7!);

    expect(patch.content).toBe([
      "# Root",
      "###### Level 6",
      "- Level 7",
      "  - Existing child",
      "  - New topic",
    ].join("\n"));
  });

  it("deletes a heading subtree without touching surrounding sections", () => {
    const source = [
      "# Root",
      "## Alpha",
      "Paragraph",
      "### Child",
      "## Beta",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const alpha = doc.root.children[0];

    const next = deleteNode(source, doc, alpha!);

    expect(next).toBe([
      "# Root",
      "## Beta",
    ].join("\n"));
  });

  it("deletes an overflow subtree", () => {
    const source = [
      "# Root",
      "###### Level 6",
      "- Level 7",
      "  [[Article 1]]",
      "  - Level 8",
      "- Level 7 sibling",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const level7 = doc.root.children[0]?.children[0];

    const next = deleteNode(source, doc, level7!);

    expect(next).toBe([
      "# Root",
      "###### Level 6",
      "- Level 7 sibling",
    ].join("\n"));
  });

  it("rejects deleting the rendered root topic", () => {
    const source = "# Root\n## Alpha\n";
    const doc = parseMarkdownToMindMap(file, source);

    expect(() => deleteNode(source, doc, doc.root)).toThrowError(StructurePatchError);
  });
});
