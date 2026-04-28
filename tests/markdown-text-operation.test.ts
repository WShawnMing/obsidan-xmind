import { describe, expect, it } from "vitest";
import {
  copyNodeSubtreeFromMarkdown,
  deleteNodeInMarkdown,
  insertChildNodeInMarkdown,
  moveNodeInMarkdown,
  pasteNodeSubtreeAfterInMarkdown,
  renameNodeInMarkdown,
} from "../src/write/markdown-text-operation";
import { parseMarkdownToMindMap } from "../src/parser/markdown-parser";

const file = {
  path: "Notes/Plan.md",
  basename: "Plan",
};

describe("markdown-text-operation", () => {
  it("renames a node by reparsing current markdown content", () => {
    const source = ["# Root", "## Alpha"].join("\n");
    const document = parseMarkdownToMindMap(file, source);
    const alphaId = document.root.children[0]!.id;

    const operation = renameNodeInMarkdown(file, source, alphaId, "Beta");

    expect(operation.content).toBe(["# Root", "## Beta"].join("\n"));
    expect(operation.preserveLayout).toBe(true);
    expect(operation.nextSelection).toEqual({
      type: "node-id",
      nodeId: alphaId,
    });
  });

  it("creates child topics as markdown text operations with inserted selection", () => {
    const source = ["# Root", "## Alpha"].join("\n");
    const document = parseMarkdownToMindMap(file, source);
    const alphaId = document.root.children[0]!.id;

    const operation = insertChildNodeInMarkdown(file, source, alphaId);

    expect(operation.content).toBe(["# Root", "## Alpha", "### New topic"].join("\n"));
    expect(operation.preserveLayout).toBe(false);
    expect(operation.preserveNodeIds).toEqual([alphaId]);
    expect(operation.nextSelection).toEqual({
      type: "inserted",
      selection: {
        kind: "heading",
        depth: 3,
        line: 3,
        text: "New topic",
      },
      startEditing: true,
    });
  });

  it("deletes a node subtree and restores selection to the parent", () => {
    const source = ["# Root", "## Alpha", "### Child", "## Beta"].join("\n");
    const document = parseMarkdownToMindMap(file, source);
    const alphaId = document.root.children[0]!.id;

    const operation = deleteNodeInMarkdown(file, source, alphaId);

    expect(operation.content).toBe(["# Root", "## Beta"].join("\n"));
    expect(operation.showBanner).toBe(true);
    expect(operation.nextSelection).toEqual({
      type: "node-id",
      nodeId: document.root.id,
    });
    expect(operation.restoreSelectionNodeId).toBe(alphaId);
  });

  it("moves a topic using freshly parsed markdown node ids", () => {
    const source = ["# Root", "## Alpha", "## Beta"].join("\n");
    const document = parseMarkdownToMindMap(file, source);
    const alphaId = document.root.children[0]!.id;
    const betaId = document.root.children[1]!.id;

    const operation = moveNodeInMarkdown(file, source, betaId, alphaId, "before");

    expect(operation.content).toBe(["# Root", "## Beta", "## Alpha"].join("\n"));
    expect(operation.nextSelection).toEqual({
      type: "inserted",
      selection: {
        kind: "heading",
        depth: 2,
        line: 2,
        text: "Beta",
      },
      startEditing: false,
    });
  });

  it("pastes a copied subtree after the selected topic using markdown text semantics", () => {
    const source = ["# Root", "## Alpha", "### Child", "## Beta"].join("\n");
    const document = parseMarkdownToMindMap(file, source);
    const alphaId = document.root.children[0]!.id;
    const betaId = document.root.children[1]!.id;
    const copied = copyNodeSubtreeFromMarkdown(file, source, alphaId);

    const operation = pasteNodeSubtreeAfterInMarkdown(file, source, betaId, copied);

    expect(operation.content).toBe([
      "# Root",
      "## Alpha",
      "### Child",
      "## Beta",
      "## Alpha",
      "### Child",
    ].join("\n"));
    expect(operation.nextSelection).toEqual({
      type: "inserted",
      selection: {
        kind: "heading",
        depth: 2,
        line: 5,
        text: "Alpha",
      },
      startEditing: false,
    });
  });
});
