import { describe, expect, it } from "vitest";
import { layoutMindMap } from "../src/layout/tree-layout";
import { parseMarkdownToMindMap } from "../src/parser/markdown-parser";

const file = {
  path: "Notes/Layout.md",
  basename: "Layout",
};

describe("layoutMindMap", () => {
  it("applies persisted node offsets without moving the parent anchor", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "## Alpha",
        "## Beta",
      ].join("\n"),
    );

    const rootId = doc.root.id;
    const alpha = doc.root.children[0]!;
    const autoLayout = layoutMindMap(doc.root);
    const movedLayout = layoutMindMap(doc.root, {
      [alpha.id]: { x: 24, y: 32 },
    });

    expect(movedLayout.nodes.get(alpha.id)?.x).toBe(
      (autoLayout.nodes.get(alpha.id)?.x ?? 0) + 24,
    );
    expect(movedLayout.nodes.get(alpha.id)?.y).toBe(
      (autoLayout.nodes.get(alpha.id)?.y ?? 0) + 32,
    );
    expect(movedLayout.nodes.get(rootId)?.y).toBe(autoLayout.nodes.get(rootId)?.y);
  });

  it("applies persisted node size overrides", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "## Alpha",
      ].join("\n"),
    );

    const alpha = doc.root.children[0]!;
    const layout = layoutMindMap(
      doc.root,
      {},
      "curved",
      {
        [alpha.id]: { width: 280, height: 92 },
      },
    );

    expect(layout.nodes.get(alpha.id)?.width).toBe(280);
    expect(layout.nodes.get(alpha.id)?.height).toBe(92);
  });

  it("reserves enough vertical space for taller internal nodes", () => {
    const doc = parseMarkdownToMindMap(
      file,
      [
        "# Root",
        "## Alpha",
        "### Alpha One",
        "### Alpha Two",
        "## Beta",
      ].join("\n"),
    );

    const alpha = doc.root.children[0]!;
    const beta = doc.root.children[1]!;
    const layout = layoutMindMap(
      doc.root,
      {},
      "curved",
      {
        [alpha.id]: { width: 260, height: 180 },
      },
    );

    const alphaPositioned = layout.nodes.get(alpha.id);
    const betaPositioned = layout.nodes.get(beta.id);

    expect(alphaPositioned).toBeDefined();
    expect(betaPositioned).toBeDefined();
    expect(betaPositioned!.y).toBeGreaterThanOrEqual(
      alphaPositioned!.y + alphaPositioned!.height,
    );
  });
});
