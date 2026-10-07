import { Extension, Node, type Editor, type JSONContent } from "@tiptap/core";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BoldIcon,
  CodeIcon,
  ChevronDownIcon,
  FilePlusIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  TextIcon,
  TextQuoteIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";

import { Button } from "../components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { docToMarkdown, markdownToDoc, RAW_MARKDOWN_NODE } from "./markdown";

/**
 * The page body: a block editor over Markdown, after ChatGPT's page editor.
 * `/` opens the insert menu, selecting text shows the format bar. Nothing in
 * here ever writes on the user's behalf; typing and Enter only ever type.
 */

export interface PageEditorHandle {
  focusStart(): void;
  focusEnd(): void;
}

export interface PageEditorProps {
  readonly markdown: string;
  readonly onChange: (markdown: string) => void;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  readonly autoFocus?: boolean;
  /** Offered in the insert menu under Create; omitted when the page cannot have subpages. */
  readonly onCreateSubpage?: (() => void) | undefined;
  readonly className?: string;
}

const SAVE_DEBOUNCE_MS = 500;

/** A block the editor does not understand, carried through verbatim. */
const RawMarkdown = Node.create({
  name: RAW_MARKDOWN_NODE,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { markdown: { default: "" } };
  },
  parseHTML() {
    return [
      { tag: "pre[data-raw-markdown]", getAttrs: (el) => ({ markdown: el.textContent ?? "" }) },
    ];
  },
  renderHTML({ node }) {
    return ["pre", { "data-raw-markdown": "" }, ["code", {}, String(node.attrs.markdown)]];
  },
});

interface SlashState {
  readonly query: string;
  readonly from: number;
  readonly to: number;
}

interface SlashCommand {
  readonly id: string;
  readonly section: "Basic" | "Create";
  readonly label: string;
  readonly description: string;
  readonly shortcut?: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly run: (editor: Editor, range: { from: number; to: number }) => void;
}

const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    id: "heading-1",
    section: "Basic",
    label: "Heading 1",
    description: "Big section heading",
    shortcut: "#",
    icon: Heading1Icon,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "heading-2",
    section: "Basic",
    label: "Heading 2",
    description: "Medium section heading",
    shortcut: "##",
    icon: Heading2Icon,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "heading-3",
    section: "Basic",
    label: "Heading 3",
    description: "Small section heading",
    shortcut: "###",
    icon: Heading3Icon,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
  },
  {
    id: "bulleted-list",
    section: "Basic",
    label: "Bulleted list",
    description: "Organize ideas in a simple list",
    shortcut: "-",
    icon: ListIcon,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    section: "Basic",
    label: "Numbered list",
    description: "An ordered list",
    shortcut: "1.",
    icon: ListOrderedIcon,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: "checklist",
    section: "Basic",
    label: "Checklist",
    description: "Track your to-dos",
    shortcut: "[]",
    icon: ListChecksIcon,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: "quote",
    section: "Basic",
    label: "Quote",
    description: "Set a quote apart from the text",
    shortcut: ">",
    icon: TextQuoteIcon,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setBlockquote().run(),
  },
  {
    id: "code",
    section: "Basic",
    label: "Code",
    description: "A block of code",
    shortcut: "```",
    icon: SquareCodeIcon,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCodeBlock().run(),
  },
  {
    id: "divider",
    section: "Basic",
    label: "Divider",
    description: "Separate sections with a line",
    shortcut: "---",
    icon: MinusIcon,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

const TEXT_STYLES: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly isActive: (editor: Editor) => boolean;
  readonly apply: (editor: Editor) => void;
}> = [
  {
    id: "text",
    label: "Text",
    isActive: (editor) =>
      editor.isActive("paragraph") &&
      !editor.isActive("bulletList") &&
      !editor.isActive("orderedList") &&
      !editor.isActive("taskList") &&
      !editor.isActive("blockquote"),
    apply: (editor) => editor.chain().focus().clearNodes().setParagraph().run(),
  },
  ...([1, 2, 3] as const).map((level) => ({
    id: `heading-${level}`,
    label: `Heading ${level}`,
    isActive: (editor: Editor) => editor.isActive("heading", { level }),
    apply: (editor: Editor) => editor.chain().focus().clearNodes().setHeading({ level }).run(),
  })),
  {
    id: "bulleted-list",
    label: "Bulleted list",
    isActive: (editor) => editor.isActive("bulletList"),
    apply: (editor) => editor.chain().focus().clearNodes().toggleBulletList().run(),
  },
  {
    id: "numbered-list",
    label: "Numbered list",
    isActive: (editor) => editor.isActive("orderedList"),
    apply: (editor) => editor.chain().focus().clearNodes().toggleOrderedList().run(),
  },
  {
    id: "checklist",
    label: "Checklist",
    isActive: (editor) => editor.isActive("taskList"),
    apply: (editor) => editor.chain().focus().clearNodes().toggleTaskList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    isActive: (editor) => editor.isActive("blockquote"),
    apply: (editor) => editor.chain().focus().clearNodes().setBlockquote().run(),
  },
  {
    id: "code",
    label: "Code",
    isActive: (editor) => editor.isActive("codeBlock"),
    apply: (editor) => editor.chain().focus().clearNodes().setCodeBlock().run(),
  },
];

function readSlashState(editor: Editor): SlashState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== "paragraph") return null;
  const text = $from.parent.textContent;
  const match = /^\/([^\s/]*)$/.exec(text);
  if (!match || $from.parentOffset !== text.length) return null;
  return { query: match[1] ?? "", from: $from.start(), to: $from.end() };
}

export const PageEditor = forwardRef<PageEditorHandle, PageEditorProps>(function PageEditor(
  {
    markdown,
    onChange,
    placeholder,
    readOnly = false,
    autoFocus = false,
    onCreateSubpage,
    className,
  },
  ref,
) {
  const lastMarkdownRef = useRef(markdown);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashRef = useRef<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashIndexRef = useRef(0);
  const [, setTick] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const commands = useMemo<ReadonlyArray<SlashCommand>>(
    () =>
      onCreateSubpage
        ? [
            ...SLASH_COMMANDS,
            {
              id: "page",
              section: "Create",
              label: "Page",
              description: "Create a page inside this one",
              icon: FilePlusIcon,
              run: (editor, range) => {
                editor.chain().focus().deleteRange(range).run();
                onCreateSubpage();
              },
            },
          ]
        : SLASH_COMMANDS,
    [onCreateSubpage],
  );

  const visibleCommands = useMemo(() => {
    if (!slash) return [];
    const query = slash.query.toLowerCase();
    return commands.filter((command) => command.label.toLowerCase().includes(query));
  }, [commands, slash]);
  const visibleRef = useRef(visibleCommands);
  useLayoutEffect(() => {
    visibleRef.current = visibleCommands;
  });

  const flush = useCallback((editor: Editor) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const next = docToMarkdown(editor.getJSON());
    if (next === lastMarkdownRef.current) return;
    lastMarkdownRef.current = next;
    onChangeRef.current(next);
  }, []);

  const SlashKeys = useMemo(
    () =>
      Extension.create({
        name: "spaceSlashKeys",
        addKeyboardShortcuts() {
          const move = (delta: number) => () => {
            if (!slashRef.current) return false;
            const count = visibleRef.current.length;
            if (count === 0) return false;
            const next = (slashIndexRef.current + delta + count) % count;
            slashIndexRef.current = next;
            setSlashIndex(next);
            return true;
          };
          return {
            ArrowDown: move(1),
            ArrowUp: move(-1),
            Enter: () => {
              const state = slashRef.current;
              const command = visibleRef.current[slashIndexRef.current];
              if (!state || !command) return false;
              command.run(this.editor, { from: state.from, to: state.to });
              return true;
            },
            Escape: () => {
              if (!slashRef.current) return false;
              slashRef.current = null;
              setSlash(null);
              return true;
            },
          };
        },
      }),
    [],
  );

  const editor = useEditor(
    {
      editable: !readOnly,
      autofocus: autoFocus ? "end" : false,
      extensions: [
        StarterKit.configure({
          underline: false,
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          link: { openOnClick: false, autolink: true, linkOnPaste: true },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: placeholder ?? "Type / for commands" }),
        RawMarkdown,
        SlashKeys,
      ],
      content: markdownToDoc(markdown),
      editorProps: {
        attributes: { class: "space-page-editor", "aria-label": "Page document" },
      },
      onUpdate: ({ editor: updated }) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => flush(updated), SAVE_DEBOUNCE_MS);
        const next = readSlashState(updated);
        slashRef.current = next;
        setSlash(next);
        if (!next) {
          slashIndexRef.current = 0;
          setSlashIndex(0);
        }
        setTick((tick) => tick + 1);
      },
      onSelectionUpdate: ({ editor: updated }) => {
        const next = readSlashState(updated);
        if ((next === null) !== (slashRef.current === null)) {
          slashRef.current = next;
          setSlash(next);
        }
        setTick((tick) => tick + 1);
      },
      onBlur: ({ editor: blurred }) => flush(blurred),
    },
    [SlashKeys],
  );

  // A changed file on disk replaces the document, unless the change was ours.
  useEffect(() => {
    if (!editor || markdown === lastMarkdownRef.current) return;
    lastMarkdownRef.current = markdown;
    editor.commands.setContent(markdownToDoc(markdown) as JSONContent, { emitUpdate: false });
  }, [editor, markdown]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Leaving the page saves whatever the debounce still holds.
  useEffect(() => {
    return () => {
      if (editor) flush(editor);
    };
  }, [editor, flush]);

  useImperativeHandle(
    ref,
    () => ({
      focusStart: () => editor?.commands.focus("start"),
      focusEnd: () => editor?.commands.focus("end"),
    }),
    [editor],
  );

  const runCommand = useCallback(
    (command: SlashCommand) => {
      const state = slashRef.current;
      if (!editor || !state) return;
      command.run(editor, { from: state.from, to: state.to });
    },
    [editor],
  );

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <EditorContent editor={editor} />
      {/* Clicking below the last block puts the cursor at the end, as in ChatGPT. */}
      <div
        aria-hidden
        className={cn("h-24", !readOnly && "cursor-text")}
        data-page-document-end
        onClick={() => editor?.commands.focus("end")}
      />
      {editor && !readOnly ? <SelectionToolbar editor={editor} container={containerRef} /> : null}
      {editor && slash && visibleCommands.length > 0 ? (
        <SlashMenu
          editor={editor}
          container={containerRef}
          anchor={slash.from}
          commands={visibleCommands}
          activeIndex={slashIndex}
          onHover={(index) => {
            slashIndexRef.current = index;
            setSlashIndex(index);
          }}
          onRun={runCommand}
        />
      ) : null}
    </div>
  );
});

/** Position of a document offset relative to the editor's wrapper. */
function offsetRect(
  editor: Editor,
  container: HTMLElement,
  pos: number,
): { left: number; top: number; bottom: number } | null {
  try {
    const coords = editor.view.coordsAtPos(pos);
    const box = container.getBoundingClientRect();
    return {
      left: coords.left - box.left,
      top: coords.top - box.top,
      bottom: coords.bottom - box.top,
    };
  } catch {
    return null;
  }
}

function SlashMenu({
  editor,
  container,
  anchor,
  commands,
  activeIndex,
  onHover,
  onRun,
}: {
  readonly editor: Editor;
  readonly container: React.RefObject<HTMLDivElement | null>;
  readonly anchor: number;
  readonly commands: ReadonlyArray<SlashCommand>;
  readonly activeIndex: number;
  readonly onHover: (index: number) => void;
  readonly onRun: (command: SlashCommand) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !container.current) return;
    const rect = offsetRect(editor, container.current, anchor);
    if (!rect) return;
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 8}px`;
    menu.style.visibility = "visible";
  }, [anchor, container, editor]);

  const sections = useMemo(() => {
    const groups: Array<{
      section: SlashCommand["section"];
      items: Array<{ command: SlashCommand; index: number }>;
    }> = [];
    commands.forEach((command, index) => {
      const last = groups.at(-1);
      if (last && last.section === command.section) last.items.push({ command, index });
      else groups.push({ section: command.section, items: [{ command, index }] });
    });
    return groups;
  }, [commands]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Insert options"
      className="invisible absolute z-50 max-h-80 w-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      {sections.map((group) => (
        <div key={group.section}>
          <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{group.section}</div>
          {group.items.map(({ command, index }) => (
            <button
              key={command.id}
              type="button"
              role="menuitem"
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm",
                index === activeIndex && "bg-accent",
              )}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRun(command)}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <command.icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {command.description}
              </span>
              {command.shortcut ? (
                <span className="ms-2 shrink-0 font-mono text-xs text-muted-foreground">
                  {command.shortcut}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function SelectionToolbar({
  editor,
  container,
}: {
  readonly editor: Editor;
  readonly container: React.RefObject<HTMLDivElement | null>;
}) {
  const { selection } = editor.state;
  const visible = !selection.empty && editor.isFocused && !editor.isActive("codeBlock");
  if (!visible) return null;
  return (
    <SelectionToolbarContent
      key={`${selection.from}-${selection.to}`}
      editor={editor}
      container={container}
      from={selection.from}
      to={selection.to}
    />
  );
}

function SelectionToolbarContent({
  editor,
  container,
  from,
  to,
}: {
  readonly editor: Editor;
  readonly container: React.RefObject<HTMLDivElement | null>;
  readonly from: number;
  readonly to: number;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !container.current) return;
    const start = offsetRect(editor, container.current, from);
    const end = offsetRect(editor, container.current, to);
    if (!start || !end) return;
    const top = Math.min(start.top, end.top);
    const left = start.top === end.top ? (start.left + end.left) / 2 : start.left;
    wrapper.style.left = `${left}px`;
    wrapper.style.top = `${top}px`;
    wrapper.style.visibility = "visible";
  }, [container, editor, from, to]);

  const activeStyle = TEXT_STYLES.find((style) => style.isActive(editor)) ?? TEXT_STYLES[0]!;
  const marks: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly icon: ComponentType<{ className?: string }>;
    readonly active: boolean;
    readonly run: () => void;
  }> = [
    {
      id: "bold",
      label: "Bold",
      icon: BoldIcon,
      active: editor.isActive("bold"),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      id: "italic",
      label: "Italic",
      icon: ItalicIcon,
      active: editor.isActive("italic"),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      id: "strike",
      label: "Strikethrough",
      icon: StrikethroughIcon,
      active: editor.isActive("strike"),
      run: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      id: "code",
      label: "Code",
      icon: CodeIcon,
      active: editor.isActive("code"),
      run: () => editor.chain().focus().toggleCode().run(),
    },
  ];

  const submitLink = () => {
    const href = (linkDraft ?? "").trim();
    if (href.length === 0) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().setLink({ href }).run();
    setLinkDraft(null);
  };

  return (
    <div
      ref={wrapperRef}
      role="region"
      aria-label="Formatting"
      className="invisible absolute z-40 -translate-x-1/2 -translate-y-full pb-2"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center gap-0.5 rounded-xl border border-border bg-popover p-1 shadow-lg">
        {linkDraft !== null ? (
          <input
            autoFocus
            aria-label="Link URL"
            className="h-7 w-64 rounded-md bg-transparent px-2 text-sm outline-none"
            placeholder="Paste a link"
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitLink();
              if (event.key === "Escape") setLinkDraft(null);
            }}
            onBlur={submitLink}
          />
        ) : (
          <>
            {marks.map((mark) => (
              <ToolbarButton
                key={mark.id}
                label={mark.label}
                active={mark.active}
                onClick={mark.run}
              >
                <mark.icon className="size-4" />
              </ToolbarButton>
            ))}
            <ToolbarButton
              label="Link"
              active={editor.isActive("link")}
              onClick={() => setLinkDraft(String(editor.getAttributes("link").href ?? ""))}
            >
              <LinkIcon className="size-4" />
            </ToolbarButton>
            <span className="mx-1 h-5 w-px bg-border" />
            <Menu>
              <MenuTrigger
                render={<Button size="compact" variant="ghost" aria-label="Text styles" />}
              >
                <TextIcon className="size-4" />
                <span className="text-xs">{activeStyle.label}</span>
                <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              </MenuTrigger>
              <MenuPopup align="start">
                <MenuRadioGroup
                  value={activeStyle.id}
                  onValueChange={(value) =>
                    TEXT_STYLES.find((style) => style.id === value)?.apply(editor)
                  }
                >
                  {TEXT_STYLES.map((style) => (
                    <MenuRadioItem key={style.id} value={style.id}>
                      {style.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          </>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  active,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant={active ? "secondary" : "ghost"}
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
