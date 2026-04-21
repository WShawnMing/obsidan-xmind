import type { MindMapNode } from "../types";

export type TitlePatchErrorCode = "INVALID_TITLE" | "NOT_EDITABLE" | "STALE_SOURCE";

export class TitlePatchError extends Error {
  code: TitlePatchErrorCode;

  constructor(code: TitlePatchErrorCode, message: string) {
    super(message);
    this.name = "TitlePatchError";
    this.code = code;
  }
}

export function patchNodeTitle(
  content: string,
  node: MindMapNode,
  nextTitle: string,
): string {
  if (node.source.kind === "virtual-root" || !node.source.span) {
    throw new TitlePatchError("NOT_EDITABLE", "Only heading nodes can be edited.");
  }

  if (/[\r\n]/.test(nextTitle)) {
    throw new TitlePatchError("INVALID_TITLE", "Node titles must stay on one line.");
  }

  const currentText = content.slice(node.source.span.from, node.source.span.to);
  if (currentText !== node.text) {
    throw new TitlePatchError(
      "STALE_SOURCE",
      "The source note changed after the mind map was parsed.",
    );
  }

  if (currentText === nextTitle) {
    return content;
  }

  return `${content.slice(0, node.source.span.from)}${nextTitle}${content.slice(node.source.span.to)}`;
}
