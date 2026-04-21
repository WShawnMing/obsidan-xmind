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
});
