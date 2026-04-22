import { describe, expect, it } from "vitest";
import { parseMarkdownToMindMap } from "../src/parser/markdown-parser";
import {
  copyNodeSubtree,
  StructurePatchError,
  deleteNode,
  insertChildNode,
  insertSiblingNode,
  moveNode,
  pasteNodeSubtreeAfter,
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

  it("moves a heading after another sibling", () => {
    const source = [
      "# Root",
      "## Alpha",
      "## Beta",
      "## Gamma",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);

    const patch = moveNode(
      source,
      doc,
      doc.root.children[0]!,
      doc.root.children[2]!,
      "after",
    );

    expect(patch.content).toBe([
      "# Root",
      "## Beta",
      "## Gamma",
      "## Alpha",
    ].join("\n"));
    expect(patch.insertedNode?.line).toBe(4);
  });

  it("moves a heading to become a child of another heading", () => {
    const source = [
      "# Root",
      "## Alpha",
      "## Beta",
      "### Beta Child",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);

    const patch = moveNode(
      source,
      doc,
      doc.root.children[0]!,
      doc.root.children[1]!,
      "child",
    );

    expect(patch.content).toBe([
      "# Root",
      "## Beta",
      "### Beta Child",
      "### Alpha",
    ].join("\n"));
  });

  it("converts moved headings into overflow list items under H6", () => {
    const source = [
      "# Root",
      "###### Level 6",
      "## Alpha",
      "### Child",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);

    const patch = moveNode(
      source,
      doc,
      doc.root.children[1]!,
      doc.root.children[0]!,
      "child",
    );

    expect(patch.content).toBe([
      "# Root",
      "###### Level 6",
      "- Alpha",
      "  - Child",
    ].join("\n"));
  });

  it("moves an overflow subtree before a sibling overflow subtree", () => {
    const source = [
      "# Root",
      "###### Level 6",
      "- Alpha",
      "  - Child",
      "- Beta",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const level6 = doc.root.children[0]!;

    const patch = moveNode(
      source,
      doc,
      level6.children[1]!,
      level6.children[0]!,
      "before",
    );

    expect(patch.content).toBe([
      "# Root",
      "###### Level 6",
      "- Beta",
      "- Alpha",
      "  - Child",
    ].join("\n"));
  });

  it("copies a heading subtree and pastes it after another sibling", () => {
    const source = [
      "# Root",
      "## Alpha",
      "### Child",
      "[[Article]]",
      "## Beta",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const copied = copyNodeSubtree(source, doc.root.children[0]!);

    const patch = pasteNodeSubtreeAfter(
      source,
      doc,
      doc.root.children[1]!,
      copied,
    );

    expect(patch.content).toBe([
      "# Root",
      "## Alpha",
      "### Child",
      "[[Article]]",
      "## Beta",
      "## Alpha",
      "### Child",
      "[[Article]]",
    ].join("\n"));
    expect(patch.insertedNode).toEqual({
      kind: "heading",
      depth: 2,
      line: 6,
      text: "Alpha",
    });
  });

  it("pastes a heading subtree under H6 as overflow items", () => {
    const source = [
      "# Root",
      "###### Level 6",
      "## Alpha",
      "### Child",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const copied = copyNodeSubtree(source, doc.root.children[1]!);

    const patch = pasteNodeSubtreeAfter(
      source,
      doc,
      doc.root.children[0]!,
      copied,
    );

    expect(patch.content).toBe([
      "# Root",
      "###### Level 6",
      "###### Alpha",
      "- Child",
      "## Alpha",
      "### Child",
    ].join("\n"));
  });

  it("copies an overflow subtree and pastes it after a sibling overflow node", () => {
    const source = [
      "# Root",
      "###### Level 6",
      "- Alpha",
      "  - Child",
      "- Beta",
    ].join("\n");
    const doc = parseMarkdownToMindMap(file, source);
    const copied = copyNodeSubtree(source, doc.root.children[0]!.children[0]!);

    const patch = pasteNodeSubtreeAfter(
      source,
      doc,
      doc.root.children[0]!.children[1]!,
      copied,
    );

    expect(patch.content).toBe([
      "# Root",
      "###### Level 6",
      "- Alpha",
      "  - Child",
      "- Beta",
      "- Alpha",
      "  - Child",
    ].join("\n"));
  });
});
