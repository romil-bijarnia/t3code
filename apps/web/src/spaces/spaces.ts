import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import type { IconName } from "lucide-react/dynamic";
import { useMemo } from "react";

import { useProjects } from "../state/entities";

/**
 * A Space is an ordinary project whose folder sits in `~/Spaces`. The folder
 * is the Space: chats run inside it, so the assistant reads its instructions
 * and can open its pages and files like any other workspace.
 *
 * Layout mirrors ChatGPT's Spaces: the Space itself is a page (README.md,
 * the "About" page), and every other page is a Markdown file under `pages/`.
 * A page's subpages live in a folder with the page's name next to its file.
 */
export const SPACES_FOLDER = "Spaces";
export const SPACE_ROOT_PAGE = "README.md";
export const SPACE_INSTRUCTIONS_FILE = "AGENTS.md";
export const SPACE_PAGES_DIR = "pages";
export const SPACE_FILES_DIR = "files";
/** Deleted pages, files and whole Spaces move here instead of disappearing. */
export const SPACE_TRASH_DIR = ".trash";

const HOME = String.raw`(?:/Users/[^/]+|/home/[^/]+|/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)`;
const SEP = String.raw`[\\/]`;
const NAME = String.raw`[^\\/]+`;
// `~/Spaces/<Name>`: a live Space.
const SPACE_ROOT_PATTERN = new RegExp(`^${HOME}${SEP}Spaces${SEP}(${NAME})${SEP}?$`);
// `~/Spaces/.trash/<stamp>/<Name>`: a Space waiting in the trash.
const TRASHED_SPACE_ROOT_PATTERN = new RegExp(
  `^${HOME}${SEP}Spaces${SEP}\\.trash${SEP}${NAME}${SEP}(${NAME})${SEP}?$`,
);
const SPACES_FOLDER_PATTERN = new RegExp(`^${HOME}${SEP}Spaces(?:${SEP}|$)`);

export function isSpaceWorkspaceRoot(workspaceRoot: string): boolean {
  return SPACE_ROOT_PATTERN.test(workspaceRoot);
}

export function isTrashedSpaceWorkspaceRoot(workspaceRoot: string): boolean {
  return TRASHED_SPACE_ROOT_PATTERN.test(workspaceRoot);
}

/** Anything under `~/Spaces`, live or trashed. Keeps Spaces out of the project tree. */
export function isInsideSpacesFolder(workspaceRoot: string): boolean {
  return SPACES_FOLDER_PATTERN.test(workspaceRoot);
}

/** The `~/Spaces` folder a Space lives in, taken from its own absolute root. */
export function spacesFolderOf(workspaceRoot: string): string {
  const match = SPACES_FOLDER_PATTERN.exec(workspaceRoot);
  return match ? match[0].replace(/[\\/]$/, "") : workspaceRoot;
}

export function spaceFolderName(workspaceRoot: string): string {
  return (
    workspaceRoot
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? workspaceRoot
  );
}

export function useSpaces(): ReadonlyArray<EnvironmentProject> {
  const projects = useProjects();
  return useMemo(
    () =>
      projects
        .filter((project) => isSpaceWorkspaceRoot(project.workspaceRoot))
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );
}

export function useTrashedSpaces(): ReadonlyArray<EnvironmentProject> {
  const projects = useProjects();
  return useMemo(
    () =>
      projects
        .filter((project) => isTrashedSpaceWorkspaceRoot(project.workspaceRoot))
        .toSorted((left, right) => right.workspaceRoot.localeCompare(left.workspaceRoot)),
    [projects],
  );
}

export function useSpace(spaceId: string): EnvironmentProject | null {
  const spaces = useSpaces();
  return spaces.find((space) => space.id === spaceId) ?? null;
}

/** A file or folder name that is safe on every desktop OS. */
export function safeFileName(name: string): string {
  return (
    name
      // oxlint-disable-next-line no-control-regex -- control characters are not allowed in file names
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 80)
      .trim()
  );
}

export function spaceWorkspaceRoot(name: string): string {
  return `~/${SPACES_FOLDER}/${safeFileName(name)}`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface SpacePageRef {
  /** `README.md` for the Space itself, else `pages/.../Title.md`. */
  readonly relativePath: string;
}

export function isRootPage(relativePath: string): boolean {
  return relativePath === SPACE_ROOT_PAGE;
}

export function isPagePath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith(".md") && !entryName(relativePath).startsWith(".");
}

export function pageTitle(relativePath: string): string {
  return entryName(relativePath).replace(/\.md$/i, "");
}

/** The folder a page's subpages live in: `pages/A.md` → `pages/A`. */
export function pageChildrenDir(relativePath: string): string {
  if (isRootPage(relativePath)) return SPACE_PAGES_DIR;
  return relativePath.replace(/\.md$/i, "");
}

export function childPagePath(parentRelativePath: string, title: string): string {
  return `${pageChildrenDir(parentRelativePath)}/${safeFileName(title) || "Untitled"}.md`;
}

export function pageParentPath(relativePath: string): string {
  if (isRootPage(relativePath)) return SPACE_ROOT_PAGE;
  const dir = parentDirectory(relativePath);
  return dir === SPACE_PAGES_DIR ? SPACE_ROOT_PAGE : `${dir}.md`;
}

export function entryName(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

export function parentDirectory(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

export function isVisibleEntry(relativePath: string): boolean {
  return !entryName(relativePath).startsWith(".");
}

/** Picks `base`, or `base 2`, `base 3`... when the name is already taken. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function trashStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function trashRelativePath(relativePath: string, now = new Date()): string {
  return `${SPACE_TRASH_DIR}/${trashStamp(now)}/${entryName(relativePath)}`;
}

export interface SpaceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface SpacePageNode {
  readonly relativePath: string;
  readonly title: string;
  readonly hasChildren: boolean;
}

/**
 * Turns one directory listing into page rows. A folder without a matching
 * file is still a page (its file appears on first save), so nothing a user
 * made in Finder is hidden.
 */
export function pagesFromEntries(entries: ReadonlyArray<SpaceEntry>): ReadonlyArray<SpacePageNode> {
  const dirs = new Set(
    entries
      .filter((entry) => entry.kind === "directory" && isVisibleEntry(entry.path))
      .map((e) => e.path),
  );
  const files = entries.filter((entry) => entry.kind === "file" && isPagePath(entry.path));
  const pages = new Map<string, SpacePageNode>();
  for (const file of files) {
    const base = file.path.replace(/\.md$/i, "");
    pages.set(base, {
      relativePath: file.path,
      title: pageTitle(file.path),
      hasChildren: dirs.has(base),
    });
  }
  for (const dir of dirs) {
    if (!pages.has(dir)) {
      pages.set(dir, { relativePath: `${dir}.md`, title: entryName(dir), hasChildren: true });
    }
  }
  return [...pages.values()].toSorted((left, right) => left.title.localeCompare(right.title));
}

// ---------------------------------------------------------------------------
// Icons and colours, as in ChatGPT's Spaces
// ---------------------------------------------------------------------------

export const SPACE_ICONS: ReadonlyArray<{
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
}> = [
  { id: "bar-chart", icon: "chart-bar", label: "Bar chart" },
  { id: "book", icon: "book", label: "Book" },
  { id: "brain", icon: "brain", label: "Brain" },
  { id: "currency-dollar", icon: "dollar-sign", label: "Dollar" },
  { id: "customize", icon: "sliders-horizontal", label: "Customize" },
  { id: "desk-globe", icon: "earth", label: "Desk globe" },
  { id: "dumbbell", icon: "dumbbell", label: "Dumbbell" },
  { id: "edit", icon: "pencil", label: "Edit" },
  { id: "flask", icon: "flask-conical", label: "Flask" },
  { id: "folder", icon: "folder", label: "Folder" },
  { id: "function", icon: "square-function", label: "Function" },
  { id: "globe", icon: "globe", label: "Globe" },
  { id: "graduation-cap", icon: "graduation-cap", label: "Graduation cap" },
  { id: "health", icon: "heart-pulse", label: "Health" },
  { id: "heart", icon: "heart", label: "Heart" },
  { id: "kettlebell", icon: "weight", label: "Kettlebell" },
  { id: "logs", icon: "logs", label: "Logs" },
  { id: "lotus", icon: "flower", label: "Lotus" },
  { id: "music", icon: "music", label: "Music" },
  { id: "palette", icon: "palette", label: "Palette" },
  { id: "paw", icon: "paw-print", label: "Paw" },
  { id: "plane", icon: "plane", label: "Plane" },
  { id: "plant", icon: "sprout", label: "Plant" },
  { id: "popcorn", icon: "popcorn", label: "Popcorn" },
  { id: "scale", icon: "scale", label: "Scale" },
  { id: "stethoscope", icon: "stethoscope", label: "Stethoscope" },
  { id: "suitcase", icon: "briefcase", label: "Suitcase" },
  { id: "terminal", icon: "terminal", label: "Terminal" },
  { id: "wrench", icon: "wrench", label: "Wrench" },
  { id: "writing", icon: "pen-line", label: "Writing" },
];

export const DEFAULT_SPACE_ICON: IconName = "folder";

/** ChatGPT's eight Space colours (dark-theme values), keyed by T3's colour names. */
export const SPACE_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly hex: string | null;
}> = [
  { value: "orange", label: "Orange", hex: "#ff8549" },
  { value: "yellow", label: "Yellow", hex: "#ffd240" },
  { value: "green", label: "Green", hex: "#40c977" },
  { value: "blue", label: "Blue", hex: "#339cff" },
  { value: "purple", label: "Purple", hex: "#ad7bf9" },
  { value: "pink", label: "Pink", hex: "#ff8cc1" },
  { value: "red", label: "Red", hex: "#ff6764" },
  { value: "gray", label: "Black", hex: null },
];

export const DEFAULT_SPACE_COLOR: ProjectIconColor = "purple";

export function spaceColorHex(color: ProjectIconColor | null | undefined): string | null {
  return SPACE_COLORS.find((option) => option.value === color)?.hex ?? null;
}

export interface SpaceAppearance {
  readonly icon: IconName;
  readonly color: ProjectIconColor;
}

export function spaceAppearance(project: Pick<EnvironmentProject, "projectIcon">): SpaceAppearance {
  const icon = project.projectIcon;
  if (icon?.kind === "lucide") return { icon: icon.name as IconName, color: icon.color };
  return { icon: DEFAULT_SPACE_ICON, color: "gray" };
}

export function spaceIconOverride(appearance: SpaceAppearance): ProjectIconOverride {
  return { kind: "lucide", name: appearance.icon, color: appearance.color };
}

// ---------------------------------------------------------------------------
// Seed files
// ---------------------------------------------------------------------------

export function spaceSeedFiles(
  name: string,
): ReadonlyArray<{ readonly relativePath: string; readonly contents: string }> {
  return [
    {
      relativePath: SPACE_ROOT_PAGE,
      contents: `## About ${name}\n\nDescribe what this Space is for.\n`,
    },
    {
      relativePath: SPACE_INSTRUCTIONS_FILE,
      contents: [
        `# ${name}`,
        "",
        `You are working inside the Space called "${name}". Everything in this folder belongs to it:`,
        "",
        "- README.md is the Space's own page and says what it is for.",
        "- pages/ holds its pages as Markdown; a page's subpages sit in a folder with the page's name. Read them when they are relevant, and write or edit a page when asked to note something down.",
        "- files/ holds files added to the Space. Treat them as sources.",
        "",
        "## Instructions",
        "",
        "",
      ].join("\n"),
    },
    // Claude reads CLAUDE.md, Codex reads AGENTS.md; one set of instructions serves both.
    { relativePath: "CLAUDE.md", contents: `@${SPACE_INSTRUCTIONS_FILE}\n` },
    { relativePath: `${SPACE_PAGES_DIR}/.keep`, contents: "" },
    { relativePath: `${SPACE_FILES_DIR}/.keep`, contents: "" },
  ];
}
