import { describe, expect, it } from "vitest";
import { tokenizeInlineText } from "../src/parser/inline-tokenizer";

describe("tokenizeInlineText", () => {
  it("parses simple wikilinks", () => {
    const result = tokenizeInlineText("See [[Daily Note]] today");

    expect(result.label).toBe("See Daily Note today");
    expect(result.links).toEqual([
      {
        raw: "[[Daily Note]]",
        text: "Daily Note",
        target: "Daily Note",
        alias: undefined,
        subpath: undefined,
      },
    ]);
  });

  it("parses aliased wikilinks", () => {
    const result = tokenizeInlineText("[[Project/Spec|Spec]]");

    expect(result.label).toBe("Spec");
    expect(result.links[0]).toEqual({
      raw: "[[Project/Spec|Spec]]",
      text: "Spec",
      target: "Project/Spec",
      alias: "Spec",
      subpath: undefined,
    });
  });
});
