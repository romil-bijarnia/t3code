import type { JSONContent } from "@tiptap/core";
import type {
  BlockContent,
  Blockquote,
  Code,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

/**
 * Pages are Markdown files; the editor works on Tiptap JSON. Both directions
 * keep what they understand and carry everything else through untouched as a
 * `rawMarkdown` block (tables, HTML, images...), so a page written by hand or
 * by an assistant never loses anything by being opened here.
 */

export const RAW_MARKDOWN_NODE = "rawMarkdown";

const parser = unified().use(remarkParse).use(remarkGfm);
const printer = unified().use(remarkGfm).use(remarkStringify, {
  bullet: "-",
  emphasis: "_",
  strong: "*",
  fences: true,
  listItemIndent: "one",
  rule: "-",
});

// ---------------------------------------------------------------------------
// Markdown → Tiptap
// ---------------------------------------------------------------------------

export function markdownToDoc(markdown: string): JSONContent {
  const tree = parser.parse(markdown) as Root;
  const content = tree.children.flatMap((node) => blockToTiptap(node, markdown));
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

function blockToTiptap(node: RootContent, source: string): JSONContent[] {
  switch (node.type) {
    case "paragraph":
      return paragraphToTiptap(node, source);
    case "heading":
      return [
        {
          type: "heading",
          attrs: { level: node.depth },
          content: inlineToTiptap(node.children) ?? [],
        },
      ];
    case "list":
      return [listToTiptap(node, source)];
    case "blockquote":
      return [
        {
          type: "blockquote",
          content: blockChildren((node as Blockquote).children, source),
        },
      ];
    case "code":
      return [
        {
          type: "codeBlock",
          attrs: { language: (node as Code).lang ?? null },
          ...((node as Code).value
            ? { content: [{ type: "text", text: (node as Code).value }] }
            : {}),
        },
      ];
    case "thematicBreak":
      return [{ type: "horizontalRule" }];
    default:
      return [rawBlock(node, source)];
  }
}

function blockChildren(children: ReadonlyArray<RootContent>, source: string): JSONContent[] {
  const content = children.flatMap((child) => blockToTiptap(child, source));
  return content.length > 0 ? content : [{ type: "paragraph" }];
}

function paragraphToTiptap(node: Paragraph, source: string): JSONContent[] {
  const inline = inlineToTiptap(node.children);
  if (inline === null) return [rawBlock(node, source)];
  return [{ type: "paragraph", ...(inline.length > 0 ? { content: inline } : {}) }];
}

function listToTiptap(node: List, source: string): JSONContent {
  const isTaskList = node.children.some((item) => typeof item.checked === "boolean");
  const items = node.children.map((item) => listItemToTiptap(item, source, isTaskList));
  if (isTaskList) return { type: "taskList", content: items };
  if (node.ordered) {
    return { type: "orderedList", attrs: { start: node.start ?? 1 }, content: items };
  }
  return { type: "bulletList", content: items };
}

function listItemToTiptap(item: ListItem, source: string, task: boolean): JSONContent {
  let content = blockChildren(item.children, source);
  // Tiptap list items open with a paragraph; a nested list straight away
  // gets an empty one in front.
  if (content[0]?.type !== "paragraph") content = [{ type: "paragraph" }, ...content];
  return task
    ? { type: "taskItem", attrs: { checked: item.checked === true }, content }
    : { type: "listItem", content };
}

/** Returns null when the run holds something only raw Markdown can express. */
function inlineToTiptap(
  nodes: ReadonlyArray<PhrasingContent>,
  marks: ReadonlyArray<Mark> = [],
): JSONContent[] | null {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push(textNode(node.value, marks));
        break;
      case "strong":
      case "emphasis":
      case "delete": {
        const mark: Mark = {
          type: node.type === "strong" ? "bold" : node.type === "emphasis" ? "italic" : "strike",
        };
        const inner = inlineToTiptap(node.children, [...marks, mark]);
        if (inner === null) return null;
        out.push(...inner);
        break;
      }
      case "inlineCode":
        out.push(textNode(node.value, [...marks, { type: "code" }]));
        break;
      case "link": {
        const mark: Mark = { type: "link", attrs: { href: node.url, title: node.title ?? null } };
        const inner = inlineToTiptap(node.children, [...marks, mark]);
        if (inner === null) return null;
        out.push(...inner);
        break;
      }
      case "break":
        out.push({ type: "hardBreak" });
        break;
      default:
        return null;
    }
  }
  return out;
}

type Mark = { type: string; attrs?: Record<string, unknown> };

function textNode(text: string, marks: ReadonlyArray<Mark>): JSONContent {
  return { type: "text", text, ...(marks.length > 0 ? { marks: [...marks] } : {}) };
}

function rawBlock(node: RootContent, source: string): JSONContent {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const markdown =
    start !== undefined && end !== undefined
      ? source.slice(start, end)
      : printer.stringify({ type: "root", children: [node] } as Root);
  return { type: RAW_MARKDOWN_NODE, attrs: { markdown } };
}

// ---------------------------------------------------------------------------
// Tiptap → Markdown
// ---------------------------------------------------------------------------

export function docToMarkdown(doc: JSONContent): string {
  const children = (doc.content ?? []).flatMap(blockToMdast);
  const root: Root = { type: "root", children };
  const markdown = printer.stringify(root);
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

function blockToMdast(node: JSONContent): RootContent[] {
  switch (node.type) {
    case "paragraph":
      return [{ type: "paragraph", children: inlineToMdast(node.content ?? []) }];
    case "heading":
      return [
        {
          type: "heading",
          depth: clampDepth(node.attrs?.level),
          children: inlineToMdast(node.content ?? []),
        } satisfies Heading,
      ];
    case "bulletList":
      return [{ type: "list", ordered: false, spread: false, children: listItemsToMdast(node) }];
    case "orderedList":
      return [
        {
          type: "list",
          ordered: true,
          start: typeof node.attrs?.start === "number" ? node.attrs.start : 1,
          spread: false,
          children: listItemsToMdast(node),
        },
      ];
    case "taskList":
      return [{ type: "list", ordered: false, spread: false, children: listItemsToMdast(node) }];
    case "blockquote":
      return [
        {
          type: "blockquote",
          children: (node.content ?? []).flatMap(blockToMdast) as BlockContent[],
        },
      ];
    case "codeBlock":
      return [
        {
          type: "code",
          lang: typeof node.attrs?.language === "string" ? node.attrs.language : null,
          value: (node.content ?? []).map((child) => child.text ?? "").join(""),
        },
      ];
    case "horizontalRule":
      return [{ type: "thematicBreak" }];
    case RAW_MARKDOWN_NODE:
      // `html` nodes are printed verbatim, which is exactly what a raw block wants.
      return [{ type: "html", value: String(node.attrs?.markdown ?? "") }];
    default:
      return [];
  }
}

function listItemsToMdast(list: JSONContent): ListItem[] {
  return (list.content ?? []).map((item) => ({
    type: "listItem",
    spread: false,
    ...(item.type === "taskItem" ? { checked: item.attrs?.checked === true } : {}),
    children: (item.content ?? []).flatMap(blockToMdast) as BlockContent[],
  }));
}

function inlineToMdast(nodes: ReadonlyArray<JSONContent>): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out.push({ type: "break" });
      continue;
    }
    if (node.type !== "text") continue;
    const text = node.text ?? "";
    const marks = node.marks ?? [];
    const code = marks.some((mark) => mark.type === "code");
    let leaf: PhrasingContent = code
      ? { type: "inlineCode", value: text }
      : { type: "text", value: text };
    // Wrap inside-out so `link` ends up outermost, the way Markdown nests them.
    for (const mark of marks.toReversed()) {
      if (mark.type === "bold") leaf = { type: "strong", children: [leaf] };
      else if (mark.type === "italic") leaf = { type: "emphasis", children: [leaf] };
      else if (mark.type === "strike") leaf = { type: "delete", children: [leaf] };
    }
    const link = marks.find((mark) => mark.type === "link");
    if (link) {
      leaf = {
        type: "link",
        url: String(link.attrs?.href ?? ""),
        title: typeof link.attrs?.title === "string" ? link.attrs.title : null,
        children: [leaf],
      };
    }
    out.push(leaf);
  }
  return out;
}

function clampDepth(level: unknown): Heading["depth"] {
  const depth = typeof level === "number" ? Math.min(6, Math.max(1, Math.round(level))) : 1;
  return depth as Heading["depth"];
}
