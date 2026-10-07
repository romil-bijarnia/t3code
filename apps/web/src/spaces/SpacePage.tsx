import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AuthFilesystemWriteScope } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  EllipsisIcon,
  FileIcon,
  FileTextIcon,
  MessageSquareIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import {
  useProjectEntriesQuery,
  useProjectFileQuery,
} from "../components/files/projectFilesQueryState";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useAllEnvironmentProjectSnapshotsReady, useThreadShells } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { PageEditor, type PageEditorHandle } from "./PageEditor";
import { DeleteDialog, RenameDialog } from "./SpaceDialogs";
import { SpaceIcon } from "./SpaceIcon";
import { SpaceIconPicker } from "./SpaceIconPicker";
import {
  entryName,
  isRootPage,
  isVisibleEntry,
  pageChildrenDir,
  pagesFromEntries,
  pageTitle,
  SPACE_FILES_DIR,
  SPACE_INSTRUCTIONS_FILE,
  SPACE_ROOT_PAGE,
  spaceAppearance,
  trashRelativePath,
  useSpace,
} from "./spaces";
import { useSpaceActions } from "./useSpaceActions";

// Files travel to the server as one base64 message, so keep them modest.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function SpacePage({
  spaceId,
  page,
}: {
  readonly spaceId: string;
  readonly page: string | null;
}) {
  const space = useSpace(spaceId);
  const projectsReady = useAllEnvironmentProjectSnapshotsReady();
  const navigate = useNavigate();
  const pagePath = page ?? SPACE_ROOT_PAGE;
  const isRoot = isRootPage(pagePath);
  const isInstructions = pagePath === SPACE_INSTRUCTIONS_FILE;
  const { createPage, deletePage, deleteSpace, renamePage, renameSpace } = useSpaceActions();
  const openPath = useOpenPath(space);
  const children = useProjectEntriesQuery(
    space?.environmentId ?? ("" as EnvironmentProject["environmentId"]),
    space?.workspaceRoot ?? "",
    pageChildrenDir(pagePath),
  );
  const childPages = useMemo(() => pagesFromEntries(children.data?.entries ?? []), [children.data]);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  // Set right before navigating so the next page lands with the cursor in place:
  // the title for a page that was just made, the body after a rename.
  const [pendingFocus, setPendingFocus] = useState<{
    page: string;
    focus: "title" | "editor";
  } | null>(null);

  const go = useCallback(
    (next?: string) =>
      void navigate({
        to: "/spaces/$spaceId",
        params: { spaceId },
        search: next ? { page: next } : {},
      }),
    [navigate, spaceId],
  );

  const addPage = async () => {
    if (!space) return;
    const created = await createPage(
      space,
      isInstructions ? SPACE_ROOT_PAGE : pagePath,
      new Set(childPages.map((child) => child.title)),
    );
    if (created) {
      setPendingFocus({ page: created, focus: "title" });
      go(created);
    }
  };

  const copyMarkdown = async () => {
    if (!space) return;
    try {
      const text = document.querySelector<HTMLElement>("[data-space-page-markdown]")?.dataset
        .spacePageMarkdown;
      await navigator.clipboard.writeText(text ?? "");
      toastManager.add({ type: "success", title: "Copied as Markdown" });
    } catch {
      toastManager.add({ type: "error", title: "Could not copy page" });
    }
  };

  const title = !space
    ? "Space"
    : isRoot
      ? space.title
      : isInstructions
        ? "Instructions"
        : pageTitle(pagePath);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Space breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current={isRoot}>
              {isRoot ? (
                <h1 className="flex items-center gap-2">
                  {space ? <SpaceIcon appearance={spaceAppearance(space)} /> : null}
                  <span className="truncate">{title}</span>
                </h1>
              ) : (
                <button type="button" className="flex items-center gap-2" onClick={() => go()}>
                  {space ? <SpaceIcon appearance={spaceAppearance(space)} /> : null}
                  <span className="truncate">{space?.title ?? "Space"}</span>
                </button>
              )}
            </WorkspaceBreadcrumbItem>
            {!isRoot ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current className="min-w-0">
                  <WorkspaceBreadcrumbText className="truncate">{title}</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          {space ? (
            <div className="flex shrink-0 items-center gap-0.5">
              <HeaderButton label="New page" onClick={() => void addPage()}>
                <PlusIcon />
              </HeaderButton>
              <Menu>
                <MenuTrigger
                  render={<Button size="icon-sm" variant="ghost-muted" aria-label="Page actions" />}
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  {!isInstructions ? (
                    <MenuItem onClick={() => setDialog("rename")}>Rename</MenuItem>
                  ) : null}
                  {isRoot ? (
                    <MenuItem onClick={() => go(SPACE_INSTRUCTIONS_FILE)}>
                      Assistant instructions
                    </MenuItem>
                  ) : null}
                  <MenuItem onClick={() => void copyMarkdown()}>Copy as Markdown</MenuItem>
                  <MenuItem
                    onClick={() =>
                      openPath(isRoot ? space.workspaceRoot : `${space.workspaceRoot}/${pagePath}`)
                    }
                  >
                    {isRoot ? "Show in Finder" : "Show file in Finder"}
                  </MenuItem>
                  {!isInstructions ? (
                    <>
                      <MenuSeparator />
                      <MenuItem variant="destructive" onClick={() => setDialog("delete")}>
                        Delete
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
          ) : null}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!space ? (
            <p className="mx-auto max-w-3xl px-6 py-12 text-base text-muted-foreground">
              {projectsReady ? "This space no longer exists." : "Loading..."}
            </p>
          ) : (
            <SpaceDocument
              key={pagePath}
              space={space}
              pagePath={pagePath}
              childPages={childPages}
              initialFocus={pendingFocus?.page === pagePath ? pendingFocus.focus : null}
              onFocused={() => setPendingFocus(null)}
              onOpenPage={go}
              onNewPage={() => void addPage()}
              onRenamed={(next) => {
                if (next === pagePath) return;
                setPendingFocus({ page: next, focus: "editor" });
                go(next);
              }}
            />
          )}
        </div>
      </div>
      {space && dialog === "rename" ? (
        <RenameDialog
          kind={isRoot ? "space" : "page"}
          initialValue={title}
          onClose={() => setDialog(null)}
          onSave={async (value) => {
            if (isRoot) {
              await renameSpace(space, value);
            } else {
              const next = await renamePage(space, pagePath, value, childPages.length > 0);
              if (next && next !== pagePath) {
                setPendingFocus({ page: next, focus: "editor" });
                go(next);
              }
            }
          }}
        />
      ) : null}
      {space && dialog === "delete" ? (
        <DeleteDialog
          kind={isRoot ? "space" : "page"}
          title={title}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            if (isRoot) {
              if (await deleteSpace(space)) void navigate({ to: "/" });
            } else if (await deletePage(space, pagePath, childPages.length > 0)) {
              go();
            }
          }}
        />
      ) : null}
    </SidebarInset>
  );
}

/**
 * One page in ChatGPT's page frame: symbol, title, body, then the subpages
 * list. The Space's own page also lists its files and chats.
 */
function SpaceDocument({
  space,
  pagePath,
  childPages,
  initialFocus,
  onFocused,
  onOpenPage,
  onNewPage,
  onRenamed,
}: {
  readonly space: EnvironmentProject;
  readonly pagePath: string;
  readonly childPages: ReturnType<typeof pagesFromEntries>;
  readonly initialFocus: "title" | "editor" | null;
  readonly onFocused: () => void;
  readonly onOpenPage: (page?: string) => void;
  readonly onNewPage: () => void;
  readonly onRenamed: (next: string) => void;
}) {
  const isRoot = isRootPage(pagePath);
  const isInstructions = pagePath === SPACE_INSTRUCTIONS_FILE;
  const file = useProjectFileQuery(space.environmentId, space.workspaceRoot, pagePath);
  const canWrite = useEnvironmentScope(space.environmentId, AuthFilesystemWriteScope);
  const { renamePage, renameSpace, setSpaceAppearance, writeSpaceFile } = useSpaceActions();
  const editorRef = useRef<PageEditorHandle | null>(null);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [latestMarkdown, setLatestMarkdown] = useState<string | null>(null);

  const savedTitle = isRoot ? space.title : isInstructions ? "Instructions" : pageTitle(pagePath);
  const titleValue = draftTitle ?? savedTitle;
  // A page whose file is still to be written reads as empty rather than broken.
  const markdown = file.data?.contents ?? "";
  const ready = !file.isPending || file.data !== null || file.readError !== null;

  // Focus only once the page can take input: the write permission arrives a
  // beat after mount, and a disabled field or read-only editor ignores focus.
  useEffect(() => {
    if (!canWrite || !ready || initialFocus === null) return;
    if (initialFocus === "title") {
      const title = titleRef.current;
      if (!title) return;
      title.focus();
      title.select();
    } else {
      editorRef.current?.focusEnd();
    }
    onFocused();
  }, [canWrite, initialFocus, onFocused, ready]);

  const commitTitle = async () => {
    const next = (draftTitle ?? "").trim();
    setDraftTitle(null);
    if (next.length === 0 || next === savedTitle) return;
    if (isRoot) {
      await renameSpace(space, next);
      return;
    }
    const moved = await renamePage(space, pagePath, next, childPages.length > 0);
    if (moved) onRenamed(moved);
  };

  const appearance = spaceAppearance(space);

  return (
    <div
      className="mx-auto flex w-full max-w-[47rem] flex-col gap-6 px-6 pt-10 pb-24"
      data-space-page-markdown={latestMarkdown ?? markdown}
    >
      <div className="group/page-title relative flex flex-col gap-6">
        {isRoot ? (
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Change icon"
                  className="self-start rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <SpaceIcon appearance={appearance} size="large" />
            </PopoverTrigger>
            <PopoverPopup align="start">
              <SpaceIconPicker
                value={appearance}
                onChange={(next) => void setSpaceAppearance(space, next)}
              />
            </PopoverPopup>
          </Popover>
        ) : null}
        {isInstructions ? (
          <h1 className="text-3xl leading-tight font-semibold">Instructions</h1>
        ) : (
          <textarea
            ref={titleRef}
            aria-label={isRoot ? "Space name" : "Page title"}
            rows={1}
            disabled={!canWrite}
            className="block w-full min-w-0 resize-none overflow-hidden border-none bg-transparent text-3xl leading-tight font-semibold break-words outline-none [field-sizing:content] placeholder:text-muted-foreground/60"
            placeholder="Untitled page"
            value={titleValue}
            onChange={(event) => setDraftTitle(event.target.value.replace(/\n/g, ""))}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
                editorRef.current?.focusStart();
              }
              if (event.key === "Escape") {
                setDraftTitle(null);
                event.currentTarget.blur();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                editorRef.current?.focusStart();
              }
            }}
          />
        )}
      </div>
      {isInstructions ? (
        <p className="-mt-3 text-sm text-muted-foreground">
          Every chat in this space follows these. Codex reads them from AGENTS.md and Claude through
          CLAUDE.md.
        </p>
      ) : null}
      {ready ? (
        <PageEditor
          ref={editorRef}
          markdown={markdown}
          readOnly={!canWrite}
          placeholder={
            isInstructions ? "Write instructions for the assistant" : "Type / for commands"
          }
          onChange={(next) => {
            setLatestMarkdown(next);
            void writeSpaceFile(space, pagePath, next);
          }}
          onCreateSubpage={isInstructions ? undefined : onNewPage}
        />
      ) : null}
      {!isInstructions && (isRoot || childPages.length > 0) ? (
        <section className="mt-8 flex flex-col gap-1 select-none" aria-label="Subpages">
          <h2 className="text-sm font-medium text-muted-foreground">Subpages</h2>
          <ul className="-mx-2">
            {childPages.map((child) => (
              <li key={child.relativePath}>
                <Row onClick={() => onOpenPage(child.relativePath)}>
                  <FileTextIcon className="size-4 text-muted-foreground" />
                  <span className="truncate">{child.title}</span>
                </Row>
              </li>
            ))}
            {canWrite ? (
              <li>
                <Row muted onClick={onNewPage}>
                  <PlusIcon className="size-4" />
                  <span>New page</span>
                </Row>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
      {isRoot ? <SpaceFiles space={space} /> : null}
      {isRoot ? <SpaceChats space={space} /> : null}
    </div>
  );
}

function SpaceChats({ space }: { readonly space: EnvironmentProject }) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const threads = useThreadShells();
  const chats = useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            thread.environmentId === space.environmentId &&
            thread.projectId === space.id &&
            thread.archivedAt === null,
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [space.environmentId, space.id, threads],
  );
  return (
    <section className="mt-8 flex flex-col gap-1 select-none" aria-label="Chats">
      <h2 className="text-sm font-medium text-muted-foreground">Chats</h2>
      <ul className="-mx-2">
        {chats.map((thread) => (
          <li key={thread.id}>
            <Row
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                })
              }
            >
              <MessageSquareIcon className="size-4 text-muted-foreground" />
              <span className="truncate">{thread.title}</span>
            </Row>
          </li>
        ))}
        <li>
          <Row
            muted
            onClick={() => void handleNewThread(scopeProjectRef(space.environmentId, space.id))}
          >
            <PlusIcon className="size-4" />
            <span>New chat</span>
          </Row>
        </li>
      </ul>
    </section>
  );
}

function SpaceFiles({ space }: { readonly space: EnvironmentProject }) {
  const { data, refresh } = useProjectEntriesQuery(
    space.environmentId,
    space.workspaceRoot,
    SPACE_FILES_DIR,
  );
  const { writeSpaceFile, moveSpaceEntry } = useSpaceActions();
  const canWrite = useEnvironmentScope(space.environmentId, AuthFilesystemWriteScope);
  const openPath = useOpenPath(space);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const files = useMemo(
    () =>
      (data?.entries ?? [])
        .filter((entry) => isVisibleEntry(entry.path))
        .map((entry) => entry.path)
        .toSorted((left, right) => entryName(left).localeCompare(entryName(right))),
    [data],
  );

  const addFiles = async (list: FileList | null) => {
    if (!list || list.length === 0 || !canWrite) return;
    const taken = new Set(files.map(entryName));
    setUploading((count) => count + list.length);
    for (const item of Array.from(list)) {
      try {
        if (item.size > MAX_UPLOAD_BYTES) {
          toastManager.add({
            type: "error",
            title: `${item.name} is too large`,
            description: "Files up to 25 MB can be added here. Use Show in Finder for bigger ones.",
          });
          continue;
        }
        const name = uniqueFileName(item.name, taken);
        taken.add(name);
        await writeSpaceFile(
          space,
          `${SPACE_FILES_DIR}/${name}`,
          await readAsBase64(item),
          "base64",
        );
      } finally {
        setUploading((count) => count - 1);
      }
    }
    refresh();
  };

  return (
    <section
      aria-label="Files"
      className={cn(
        "mt-8 flex flex-col gap-1 rounded-xl border border-transparent select-none",
        dragging && "border-dashed border-foreground/30 bg-accent/40",
      )}
      onDragOver={(event) => {
        if (!canWrite || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      <h2 className="text-sm font-medium text-muted-foreground">Files</h2>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void addFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <ul className="-mx-2">
        {files.map((path) => (
          <li key={path}>
            <Row
              onClick={() => openPath(`${space.workspaceRoot}/${path}`)}
              action={
                <HeaderButton
                  label={`Delete ${entryName(path)}`}
                  onClick={async () => {
                    if (await moveSpaceEntry(space, path, trashRelativePath(path))) refresh();
                  }}
                >
                  <Trash2Icon />
                </HeaderButton>
              }
            >
              <FileIcon className="size-4 text-muted-foreground" />
              <span className="truncate">{entryName(path)}</span>
            </Row>
          </li>
        ))}
        {canWrite ? (
          <li>
            <Row muted onClick={() => inputRef.current?.click()}>
              <UploadIcon className="size-4" />
              <span>{uploading > 0 ? "Adding..." : "Add files"}</span>
            </Row>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function useOpenPath(space: EnvironmentProject | null) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  return useCallback(
    (path: string) => {
      if (!space) return;
      void openInEditor({
        environmentId: space.environmentId,
        input: { cwd: path, editor: "file-manager" },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          toastManager.add({ type: "error", title: "Could not open it", description: path });
        }
      });
    },
    [openInEditor, space],
  );
}

function Row({
  children,
  onClick,
  action,
  muted = false,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly action?: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <div className="group/row relative">
      <button
        type="button"
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-base transition-colors hover:bg-accent",
          muted ? "text-muted-foreground hover:text-foreground" : "text-foreground",
          action !== undefined && "pr-10",
        )}
        onClick={onClick}
      >
        {children}
      </button>
      {action ? (
        <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
          {action}
        </div>
      ) : null}
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-sm" variant="ghost-muted" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem} ${suffix}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error(`Could not read ${file.name}.`)),
      { once: true },
    );
    reader.addEventListener(
      "load",
      () => {
        const result = String(reader.result);
        resolve(result.slice(result.indexOf(",") + 1));
      },
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}
