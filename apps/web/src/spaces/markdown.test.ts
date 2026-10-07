import { describe, expect, it } from "vite-plus/test";

import { docToMarkdown, markdownToDoc, RAW_MARKDOWN_NODE } from "./markdown";

const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(markdown));

describe("markdownToDoc", () => {
  it("maps the blocks the editor edits", () => {
    const doc = markdownToDoc(
      "# Title\n\nSome **bold** and _it_ text.\n\n- a\n- b\n\n1. one\n\n> quote\n\n```ts\nlet x = 1;\n```\n\n---\n",
    );
    expect(doc.content?.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "blockquote",
      "codeBlock",
      "horizontalRule",
    ]);
    expect(doc.content?.[1]?.content?.[1]).toEqual({
      type: "text",
      text: "bold",
      marks: [{ type: "bold" }],
    });
    expect(doc.content?.[5]?.attrs).toEqual({ language: "ts" });
  });

  it("turns task lists into checklists", () => {
    const doc = markdownToDoc("- [x] done\n- [ ] todo\n");
    expect(doc.content?.[0]?.type).toBe("taskList");
    expect(doc.content?.[0]?.content?.map((item) => item.attrs?.checked)).toEqual([true, false]);
  });

  it("keeps what it cannot edit as raw Markdown", () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    const doc = markdownToDoc(`Intro\n\n${table}\n\nOutro\n`);
    expect(doc.content?.[1]).toEqual({ type: RAW_MARKDOWN_NODE, attrs: { markdown: table } });
  });

  it("gives an empty page one empty paragraph", () => {
    expect(markdownToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});

describe("round trip", () => {
  it("is stable for an ordinary page", () => {
    const markdown = [
      "## About Uni",
      "",
      "Describe what this Space is for.",
      "",
      "- [ ] read _chapter_ one",
      "- [x] email [the tutor](https://example.com)",
      "",
      "1. first",
      "2. second",
      "",
      "> keep going",
      "",
      "```python",
      "print('hi')",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
    ].join("\n");
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("writes a line break and inline code the way they were read", () => {
    expect(roundTrip("line one\\\nline two with `code`\n")).toBe(
      "line one\\\nline two with `code`\n",
    );
  });
});
