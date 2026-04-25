import { describe, expect, it } from "vitest";
import { parseMarkdownToMindMap } from "../src/parser/markdown-parser";
import { findNavigationTarget } from "../src/view/navigation";

const file = {
  path: "Notes/Nav.md",
  basename: "Nav",
};

describe("findNavigationTarget", () => {
  const doc = parseMarkdownToMindMap(
    file,
    [
      "# Root",
      "## Alpha",
      "### Alpha One",
      "### Alpha Two",
      "## Beta",
      "### Beta One",
      "## Gamma",
    ].join("\n"),
  );

  const alpha = doc.root.children[0]!;
  const alphaOne = alpha.children[0]!;
  const alphaTwo = alpha.children[1]!;
  const beta = doc.root.children[1]!;
  const gamma = doc.root.children[2]!;

  it("moves up and down within siblings only", () => {
    expect(findNavigationTarget(doc.root, beta.id, "up")).toBe(alpha.id);
    expect(findNavigationTarget(doc.root, beta.id, "down")).toBe(gamma.id);
    expect(findNavigationTarget(doc.root, alphaOne.id, "down")).toBe(alphaTwo.id);
    expect(findNavigationTarget(doc.root, alphaTwo.id, "up")).toBe(alphaOne.id);
  });

  it("moves left to the parent node", () => {
    expect(findNavigationTarget(doc.root, alphaTwo.id, "left")).toBe(alpha.id);
  });

  it("moves right to the first child node", () => {
    expect(findNavigationTarget(doc.root, beta.id, "right")).toBe(beta.children[0]!.id);
  });

  it("stays on the current node when there is no target in that direction", () => {
    expect(findNavigationTarget(doc.root, alpha.id, "up")).toBe(alpha.id);
    expect(findNavigationTarget(doc.root, gamma.id, "down")).toBe(gamma.id);
    expect(findNavigationTarget(doc.root, alphaOne.id, "right")).toBe(alphaOne.id);
    expect(findNavigationTarget(doc.root, doc.root.id, "left")).toBe(doc.root.id);
  });
});
