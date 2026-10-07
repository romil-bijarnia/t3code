import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { useProjects } from "../state/entities";

/**
 * A Space is an ordinary project whose folder sits in `~/Spaces`. The folder
 * is the Space: chats run inside it, so the assistant reads its instructions
 * and can open its pages and files like any other workspace.
 */
export const SPACES_FOLDER = "Spaces";
export const SPACE_ABOUT_FILE = "README.md";
export const SPACE_INSTRUCTIONS_FILE = "AGENTS.md";
export const SPACE_PAGES_DIR = "pages";
export const SPACE_FILES_DIR = "files";
/** Deleted pages and files move here instead of disappearing. */
export const SPACE_TRASH_DIR = ".trash";

export const SPACE_TABS = ["chats", "pages", "files", "instructions"] as const;
export type SpaceTab = (typeof SPACE_TABS)[number];

// A direct child of `Spaces` in a home directory, on macOS, Linux or Windows.
const SPACE_ROOT_PATTERN =
  /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)[\\/]Spaces[\\/][^\\/]+[\\/]?$/;

export function isSpaceWorkspaceRoot(workspaceRoot: string): boolean {
  return SPACE_ROOT_PATTERN.test(workspaceRoot);
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

export function pageRelativePath(title: string): string {
  return `${SPACE_PAGES_DIR}/${safeFileName(title) || "Untitled"}.md`;
}

export function pageTitle(relativePath: string): string {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return name.replace(/\.md$/i, "");
}

export function entryName(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
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

export function trashRelativePath(relativePath: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${SPACE_TRASH_DIR}/${stamp}/${entryName(relativePath)}`;
}

export function spaceSeedFiles(
  name: string,
): ReadonlyArray<{ readonly relativePath: string; readonly contents: string }> {
  return [
    { relativePath: SPACE_ABOUT_FILE, contents: "" },
    {
      relativePath: SPACE_INSTRUCTIONS_FILE,
      contents: [
        `# ${name}`,
        "",
        `You are working inside the Space called "${name}". Everything in this folder belongs to it:`,
        "",
        "- README.md says what the Space is for.",
        "- pages/ holds its pages as Markdown. Read them when they are relevant, and write or edit a page when asked to note something down.",
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
