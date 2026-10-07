import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AuthFilesystemWriteScope } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  FileIcon,
  FileTextIcon,
  FolderOpenIcon,
  PaletteIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../components/ChatMarkdown";
import {
  useProjectEntriesQuery,
  useProjectFileQuery,
} from "../components/files/projectFilesQueryState";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { Button } from "../components/ui/button";
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
import {
  entryName,
  isVisibleEntry,
  pageRelativePath,
  pageTitle,
  SPACE_ABOUT_FILE,
  SPACE_FILES_DIR,
  SPACE_INSTRUCTIONS_FILE,
  SPACE_PAGES_DIR,
  SPACE_TABS,
  type SpaceTab,
  trashRelativePath,
  uniqueName,
  useSpace,
} from "./spaces";
import { useSpaceActions } from "./useSpaceActions";

const ProjectIconPickerDialog = lazy(() =>
  import("../components/settings/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

const TAB_LABELS: Record<SpaceTab, string> = {
  chats: "Chats",
  pages: "Pages",
  files: "Files",
  instructions: "Instructions",
};

// Files travel to the server as one base64 message, so keep them modest.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function SpacePage({
  spaceId,
  page,
  tab,
}: {
  readonly spaceId: string;
  readonly page: string | null;
  readonly tab: SpaceTab;
}) {
  const space = useSpace(spaceId);
  const projectsReady = useAllEnvironmentProjectSnapshotsReady();
  const navigate = useNavigate();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const { moveSpaceEntry, setSpaceIcon } = useSpaceActions();
  const openPath = useOpenPath(space);

  const go = useCallback(
    (search: { page?: string; tab?: SpaceTab }) =>
      void navigate({ to: "/spaces/$spaceId", params: { spaceId }, search }),
    [navigate, spaceId],
  );

  const deletePage = async () => {
    if (!space || !page) return;
    if (await moveSpaceEntry(space, page, trashRelativePath(page))) go({ tab: "pages" });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Space breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current={page === null}>
              {page === null ? (
                <h1>{space?.title ?? "Space"}</h1>
              ) : (
                <button type="button" onClick={() => go({ tab: "pages" })}>
                  {space?.title ?? "Space"}
                </button>
              )}
            </WorkspaceBreadcrumbItem>
            {page !== null ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current className="min-w-0">
                  <WorkspaceBreadcrumbText className="truncate">
                    {pageTitle(page)}
                  </WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          {space ? (
            <div className="flex shrink-0 items-center gap-0.5">
              {page !== null ? (
                <ToolbarButton label="Delete page" onClick={() => void deletePage()}>
                  <Trash2Icon />
                </ToolbarButton>
              ) : null}
              <ToolbarButton label="Change icon" onClick={() => setIconPickerOpen(true)}>
                <PaletteIcon />
              </ToolbarButton>
              <ToolbarButton label="Show in Finder" onClick={() => openPath(space.workspaceRoot)}>
                <FolderOpenIcon />
              </ToolbarButton>
            </div>
          ) : null}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!space ? (
            <p className="mx-auto max-w-3xl px-6 py-12 text-base text-muted-foreground">
              {projectsReady ? "This Space no longer exists." : "Loading..."}
            </p>
          ) : page !== null ? (
            <SpacePageView
              key={page}
              space={space}
              page={page}
              onRenamed={(next) => go({ page: next })}
            />
          ) : (
            <SpaceHome
              space={space}
              tab={tab}
              onTab={(next) => go({ tab: next })}
              onPage={(next) => go({ page: next })}
            />
          )}
        </div>
      </div>
      {space && iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={space.projectIcon?.kind === undefined ? null : space.projectIcon}
            projectName={space.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setSpaceIcon(space, icon)}
          />
        </Suspense>
      ) : null}
    </SidebarInset>
  );
}

function SpaceHome({
  space,
  tab,
  onTab,
  onPage,
}: {
  readonly space: EnvironmentProject;
  readonly tab: SpaceTab;
  readonly onTab: (tab: SpaceTab) => void;
  readonly onPage: (page: string) => void;
}) {
  const handleNewThread = useNewThreadHandler();

  return (
    <div className="mx-auto flex max-w-3xl flex-col px-6 pt-14 pb-24">
      <div className="flex items-center gap-3">
        <ProjectFavicon project={space} className="size-7" />
        <h2 className="min-w-0 truncate text-3xl leading-tight">{space.title}</h2>
      </div>
      <div className="mt-3">
        <EditableMarkdown
          space={space}
          relativePath={SPACE_ABOUT_FILE}
          placeholder="Describe what this Space is for."
          className="text-muted-foreground"
        />
      </div>
      <button
        type="button"
        className="mt-8 flex h-14 w-full items-center justify-between rounded-2xl border border-border bg-card pr-3 pl-5 text-left text-base text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
        onClick={() => void handleNewThread(scopeProjectRef(space.environmentId, space.id))}
      >
        <span>New chat in {space.title}</span>
        <span className="flex size-8 items-center justify-center rounded-full bg-foreground/90 text-background">
          <ArrowUpIcon className="size-4" />
        </span>
      </button>
      <div className="mt-10 flex items-center gap-6 border-b border-border" role="tablist">
        {SPACE_TABS.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={tab === option}
            className={cn(
              "-mb-px border-b pb-2.5 text-base transition-colors",
              tab === option
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onTab(option)}
          >
            {TAB_LABELS[option]}
          </button>
        ))}
      </div>
      <div className="pt-3">
        {tab === "chats" ? <SpaceChats space={space} /> : null}
        {tab === "pages" ? <SpacePages space={space} onPage={onPage} /> : null}
        {tab === "files" ? <SpaceFiles space={space} /> : null}
        {tab === "instructions" ? <SpaceInstructions space={space} /> : null}
      </div>
    </div>
  );
}

function SpaceChats({ space }: { readonly space: EnvironmentProject }) {
  const navigate = useNavigate();
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
  if (chats.length === 0) return <EmptyLine>No chats yet.</EmptyLine>;

  return (
    <ul>
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
            <span className="truncate">{thread.title}</span>
          </Row>
        </li>
      ))}
    </ul>
  );
}

function SpacePages({
  space,
  onPage,
}: {
  readonly space: EnvironmentProject;
  readonly onPage: (page: string) => void;
}) {
  const { data, refresh } = useProjectEntriesQuery(
    space.environmentId,
    space.workspaceRoot,
    SPACE_PAGES_DIR,
  );
  const { writeSpaceFile, moveSpaceEntry } = useSpaceActions();
  const canWrite = useEnvironmentScope(space.environmentId, AuthFilesystemWriteScope);
  const pages = useMemo(
    () =>
      (data?.entries ?? [])
        .filter(
          (entry) =>
            entry.kind === "file" &&
            isVisibleEntry(entry.path) &&
            entry.path.toLowerCase().endsWith(".md"),
        )
        .map((entry) => entry.path)
        .toSorted((left, right) => pageTitle(left).localeCompare(pageTitle(right))),
    [data],
  );

  const newPage = async () => {
    const title = uniqueName("Untitled", new Set(pages.map(pageTitle)));
    const relativePath = pageRelativePath(title);
    if (await writeSpaceFile(space, relativePath, "")) {
      refresh();
      onPage(relativePath);
    }
  };

  return (
    <ul>
      <li>
        <Row muted disabled={!canWrite} onClick={() => void newPage()}>
          <PlusIcon className="size-4" />
          <span>New page</span>
        </Row>
      </li>
      {pages.map((page) => (
        <li key={page}>
          <Row
            onClick={() => onPage(page)}
            action={
              <RowAction
                label={`Delete ${pageTitle(page)}`}
                onClick={async () => {
                  if (await moveSpaceEntry(space, page, trashRelativePath(page))) refresh();
                }}
              />
            }
          >
            <FileTextIcon className="size-4 text-muted-foreground" />
            <span className="truncate">{pageTitle(page)}</span>
          </Row>
        </li>
      ))}
    </ul>
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
    for (const file of Array.from(list)) {
      try {
        if (file.size > MAX_UPLOAD_BYTES) {
          toastManager.add({
            type: "error",
            title: `${file.name} is too large`,
            description: "Files up to 25 MB can be added here. Use Show in Finder for bigger ones.",
          });
          continue;
        }
        const name = uniqueFileName(file.name, taken);
        taken.add(name);
        await writeSpaceFile(
          space,
          `${SPACE_FILES_DIR}/${name}`,
          await readAsBase64(file),
          "base64",
        );
      } finally {
        setUploading((count) => count - 1);
      }
    }
    refresh();
  };

  return (
    <div
      className={cn(
        "-mx-3 rounded-xl border border-transparent px-3 transition-colors",
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
      <ul>
        <li>
          <Row muted disabled={!canWrite} onClick={() => inputRef.current?.click()}>
            <UploadIcon className="size-4" />
            <span>{uploading > 0 ? "Adding..." : "Add files"}</span>
          </Row>
        </li>
        {files.map((file) => (
          <li key={file}>
            <Row
              onClick={() => openPath(`${space.workspaceRoot}/${file}`)}
              action={
                <RowAction
                  label={`Delete ${entryName(file)}`}
                  onClick={async () => {
                    if (await moveSpaceEntry(space, file, trashRelativePath(file))) refresh();
                  }}
                />
              }
            >
              <FileIcon className="size-4 text-muted-foreground" />
              <span className="truncate">{entryName(file)}</span>
            </Row>
          </li>
        ))}
      </ul>
      {files.length === 0 ? (
        <EmptyLine>Drop files here. Chats in this Space can read them.</EmptyLine>
      ) : null}
    </div>
  );
}

function SpaceInstructions({ space }: { readonly space: EnvironmentProject }) {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <p className="text-sm text-muted-foreground">
        Every chat in this Space follows these. Codex reads them from AGENTS.md and Claude through
        CLAUDE.md.
      </p>
      <EditableMarkdown space={space} relativePath={SPACE_INSTRUCTIONS_FILE} alwaysEditing />
    </div>
  );
}

function SpacePageView({
  space,
  page,
  onRenamed,
}: {
  readonly space: EnvironmentProject;
  readonly page: string;
  readonly onRenamed: (page: string) => void;
}) {
  const { moveSpaceEntry } = useSpaceActions();
  const [title, setTitle] = useState(pageTitle(page));

  const rename = async () => {
    const next = pageRelativePath(title);
    if (next === page) return;
    if (title.trim().length === 0) {
      setTitle(pageTitle(page));
      return;
    }
    if (await moveSpaceEntry(space, page, next)) onRenamed(next);
    else setTitle(pageTitle(page));
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col px-6 pt-14 pb-24">
      <input
        aria-label="Page title"
        className="w-full bg-transparent text-3xl leading-tight outline-none placeholder:text-muted-foreground"
        placeholder="Untitled"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setTitle(pageTitle(page));
            event.currentTarget.blur();
          }
        }}
      />
      <div className="mt-6">
        <EditableMarkdown space={space} relativePath={page} placeholder="Start writing..." />
      </div>
    </div>
  );
}

/**
 * Shows a Markdown file and turns into a plain editor on double-click (or
 * always, for instructions). Leaving the editor saves.
 */
function EditableMarkdown({
  space,
  relativePath,
  placeholder,
  alwaysEditing = false,
  className,
}: {
  readonly space: EnvironmentProject;
  readonly relativePath: string;
  readonly placeholder?: string;
  readonly alwaysEditing?: boolean;
  readonly className?: string;
}) {
  const file = useProjectFileQuery(space.environmentId, space.workspaceRoot, relativePath);
  const { writeSpaceFile } = useSpaceActions();
  const canWrite = useEnvironmentScope(space.environmentId, AuthFilesystemWriteScope);
  const saved = file.data?.contents ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const editing = alwaysEditing || draft !== null;
  const value = draft ?? saved;
  const [savedValue, setSavedValue] = useState<string | null>(null);

  const save = async (next: string) => {
    if (next === (savedValue ?? saved)) return true;
    const ok = await writeSpaceFile(space, relativePath, next);
    if (ok) {
      setSavedValue(next);
      file.refresh();
    }
    return ok;
  };

  if (!editing) {
    const text = savedValue ?? saved;
    return text.trim().length === 0 ? (
      <button
        type="button"
        disabled={!canWrite}
        className={cn("text-left text-base text-muted-foreground/70", className)}
        onClick={() => setDraft(text)}
      >
        {file.isPending && !file.data ? "" : placeholder}
      </button>
    ) : (
      <div
        className={cn("text-base", className)}
        onDoubleClick={() => {
          if (canWrite) setDraft(text);
        }}
      >
        <ChatMarkdown text={text} cwd={space.workspaceRoot} environmentId={space.environmentId} />
      </div>
    );
  }

  return (
    <textarea
      aria-label={relativePath}
      autoFocus={!alwaysEditing}
      disabled={!canWrite}
      className={cn(
        "min-h-32 w-full resize-none bg-transparent font-sans text-base leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground/70",
        alwaysEditing && "min-h-64 rounded-xl border border-border bg-card p-4",
      )}
      placeholder={placeholder}
      value={value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        void save(value).then((ok) => {
          if (ok && !alwaysEditing) setDraft(null);
        });
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          void save(value);
        }
        if (event.key === "Escape" && !alwaysEditing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
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
  disabled = false,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly action?: ReactNode;
  readonly muted?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <div className="group/row relative">
      <button
        type="button"
        disabled={disabled}
        className={cn(
          "-mx-3 flex h-11 w-[calc(100%+1.5rem)] items-center gap-3 rounded-lg px-3 text-left text-base transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50",
          muted ? "text-muted-foreground hover:text-foreground" : "text-foreground",
          action !== undefined && "pr-11",
        )}
        onClick={onClick}
      >
        {children}
      </button>
      {action ? (
        <div className="absolute top-1/2 right-0 -translate-y-1/2 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
          {action}
        </div>
      ) : null}
    </div>
  );
}

function RowAction({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <ToolbarButton label={label} onClick={onClick}>
      <Trash2Icon />
    </ToolbarButton>
  );
}

function EmptyLine({ children }: { readonly children: ReactNode }) {
  return <p className="py-3 text-base text-muted-foreground">{children}</p>;
}

function ToolbarButton({
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
