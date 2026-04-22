import { describe, expect, it } from "vitest";
import {
  buildAssociationEndpoint,
  reconcileAssociations,
  resolveAssociationEndpoint,
} from "../src/associations";
import { parseMarkdownToMindMap } from "../src/parser/markdown-parser";

const file = {
  path: "Notes/Plan.md",
  basename: "Plan",
};

describe("associations", () => {
  it("creates endpoints from current document nodes", () => {
    const document = parseMarkdownToMindMap(file, ["# Root", "## Alpha"].join("\n"));
    const alpha = document.root.children[0];
    const endpoint = buildAssociationEndpoint(document, alpha!.id);

    expect(endpoint?.nodeId).toBe(alpha?.id);
    expect(endpoint?.locator.text).toBe("Alpha");
    expect(endpoint?.locator.ancestorTexts).toEqual(["Root"]);
  });

  it("resolves an endpoint after line-based node ids change", () => {
    const before = parseMarkdownToMindMap(file, ["# Root", "## Alpha", "## Beta"].join("\n"));
    const beta = before.root.children[1];
    const endpoint = buildAssociationEndpoint(before, beta!.id);

    const after = parseMarkdownToMindMap(
      file,
      ["# Root", "## Inserted", "## Alpha", "## Beta"].join("\n"),
    );
    const resolved = resolveAssociationEndpoint(after, endpoint!);

    expect(resolved?.text).toBe("Beta");
  });

  it("reconciles association endpoints after structural ids shift", () => {
    const before = parseMarkdownToMindMap(file, ["# Root", "## Alpha", "## Beta"].join("\n"));
    const alpha = before.root.children[0];
    const beta = before.root.children[1];

    const association = {
      id: "assoc-1",
      from: buildAssociationEndpoint(before, alpha!.id)!,
      to: buildAssociationEndpoint(before, beta!.id)!,
    };

    const after = parseMarkdownToMindMap(
      file,
      ["# Root", "## Inserted", "## Alpha", "## Beta"].join("\n"),
    );
    const result = reconcileAssociations(after, [association]);

    expect(result.changed).toBe(true);
    expect(result.associations).toHaveLength(1);
    expect(result.associations[0]?.from.nodeId).toBe(after.root.children[1]?.id);
    expect(result.associations[0]?.to.nodeId).toBe(after.root.children[2]?.id);
  });

  it("preserves relationship label metadata during reconciliation", () => {
    const before = parseMarkdownToMindMap(file, ["# Root", "## Alpha", "## Beta"].join("\n"));
    const alpha = before.root.children[0];
    const beta = before.root.children[1];

    const association = {
      id: "assoc-1",
      from: buildAssociationEndpoint(before, alpha!.id)!,
      to: buildAssociationEndpoint(before, beta!.id)!,
      label: "depends on",
      labelOffset: { x: 16, y: -8 },
    };

    const after = parseMarkdownToMindMap(
      file,
      ["# Root", "## Inserted", "## Alpha", "## Beta"].join("\n"),
    );
    const result = reconcileAssociations(after, [association]);

    expect(result.associations[0]?.label).toBe("depends on");
    expect(result.associations[0]?.labelOffset).toEqual({ x: 16, y: -8 });
  });

  it("drops associations whose endpoints can no longer be resolved", () => {
    const before = parseMarkdownToMindMap(file, ["# Root", "## Alpha", "## Beta"].join("\n"));
    const alpha = before.root.children[0];
    const beta = before.root.children[1];

    const association = {
      id: "assoc-1",
      from: buildAssociationEndpoint(before, alpha!.id)!,
      to: buildAssociationEndpoint(before, beta!.id)!,
    };

    const after = parseMarkdownToMindMap(file, ["# Root", "## Alpha"].join("\n"));
    const result = reconcileAssociations(after, [association]);

    expect(result.changed).toBe(true);
    expect(result.associations).toHaveLength(0);
  });
});
