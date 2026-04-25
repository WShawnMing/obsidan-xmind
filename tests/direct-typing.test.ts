import { describe, expect, it } from "vitest";
import { applyPendingTypingSeed } from "../src/view/direct-typing";

describe("applyPendingTypingSeed", () => {
  it("falls back to the pending seed when the input is still empty", () => {
    expect(applyPendingTypingSeed("h", "")).toBe("h");
  });

  it("does not duplicate the seed when the first key already reached the input", () => {
    expect(applyPendingTypingSeed("h", "h")).toBe("h");
  });

  it("does not prefix again when the input already starts with the seed", () => {
    expect(applyPendingTypingSeed("h", "he")).toBe("he");
  });

  it("prefixes the pending seed when a later latin key arrives first", () => {
    expect(applyPendingTypingSeed("h", "e")).toBe("he");
  });
});
