import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { refreshProjectEntriesQuery } from "../components/files/projectFilesQueryState";
import { toastManager } from "../components/ui/toast";
import { newProjectId } from "../lib/utils";
import { waitForProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import {
  childPagePath,
  entryName,
  pageChildrenDir,
  pageParentPath,
  pageTitle,
  parentDirectory,
  safeFileName,
  SPACE_PAGES_DIR,
  SPACE_TRASH_DIR,
  type SpaceAppearance,
  spaceFolderName,
  spaceIconOverride,
  spacesFolderOf,
  spaceSeedFiles,
  spaceWorkspaceRoot,
  trashStamp,
  uniqueName,
} from "./spaces";

type SpaceRef = Pick<EnvironmentProject, "environmentId" | "workspaceRoot">;
type SpaceRecord = Pick<EnvironmentProject, "environmentId" | "workspaceRoot" | "id" | "title">;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong.";
}

function reportFailure(title: string, description: string) {
  toastManager.add({ type: "error", title, description });
}

function refreshDirectory(environmentId: EnvironmentId, cwd: string, directoryPath: string) {
  refreshProjectEntriesQuery(environmentId, cwd, directoryPath);
}

/** Everything that changes a Space: its folder, its project record, its pages and files. */
export function useSpaceActions() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const moveEntry = useAtomCommand(projectEnvironment.moveEntry, { reportFailure: false });

  const writeSpaceFile = async (
    space: SpaceRef,
    relativePath: string,
    contents: string,
    encoding?: "base64",
  ): Promise<boolean> => {
    const result = await writeFile({
      environmentId: space.environmentId,
      input: {
        cwd: space.workspaceRoot,
        relativePath,
        contents,
        ...(encoding ? { encoding } : {}),
      },
    });
    if (result._tag === "Success") {
      refreshDirectory(space.environmentId, space.workspaceRoot, parentDirectory(relativePath));
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportFailure(`Could not save ${entryName(relativePath)}`, failureMessage(result));
    }
    return false;
  };

  /** Moves inside any folder the server can reach; `cwd` need not be a project. */
  const moveWithin = async (
    environmentId: EnvironmentId,
    cwd: string,
    relativePath: string,
    toRelativePath: string,
    failureTitle: string,
  ): Promise<boolean> => {
    const result = await moveEntry({
      environmentId,
      input: { cwd, relativePath, toRelativePath },
    });
    if (result._tag === "Success") {
      refreshDirectory(environmentId, cwd, parentDirectory(relativePath));
      refreshDirectory(environmentId, cwd, parentDirectory(toRelativePath));
      return true;
    }
    if (!isAtomCommandInterrupted(result)) reportFailure(failureTitle, failureMessage(result));
    return false;
  };

  const moveSpaceEntry = (space: SpaceRef, relativePath: string, toRelativePath: string) =>
    moveWithin(
      space.environmentId,
      space.workspaceRoot,
      relativePath,
      toRelativePath,
      `Could not move ${entryName(relativePath)}`,
    );

  const updateSpaceProject = async (
    space: Pick<EnvironmentProject, "environmentId" | "id">,
    input: { title?: string; workspaceRoot?: string; appearance?: SpaceAppearance },
    failureTitle: string,
  ): Promise<boolean> => {
    const result = await updateProject({
      environmentId: space.environmentId,
      input: {
        projectId: space.id,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
        ...(input.appearance
          ? { projectIcon: spaceIconOverride(input.appearance), faviconPath: null }
          : {}),
      },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) reportFailure(failureTitle, failureMessage(result));
    return false;
  };

  const setSpaceAppearance = (
    space: Pick<EnvironmentProject, "environmentId" | "id">,
    appearance: SpaceAppearance,
  ) => updateSpaceProject(space, { appearance }, "Could not save space appearance");

  const createSpace = async (input: {
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly appearance: SpaceAppearance;
  }): Promise<ProjectId | null> => {
    const projectId = newProjectId();
    const created = await createProject({
      environmentId: input.environmentId,
      input: {
        projectId,
        title: input.name,
        workspaceRoot: spaceWorkspaceRoot(input.name),
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (created._tag === "Failure") {
      if (!isAtomCommandInterrupted(created)) {
        reportFailure("Could not create the space", failureMessage(created));
      }
      return null;
    }
    // The server expands `~`; file writes need the absolute folder it stored.
    const project = await waitForProject(scopeProjectRef(input.environmentId, projectId));
    for (const file of spaceSeedFiles(input.name)) {
      if (!(await writeSpaceFile(project, file.relativePath, file.contents))) return null;
    }
    await setSpaceAppearance(project, input.appearance);
    return projectId;
  };

  const renameSpace = async (space: SpaceRecord, name: string): Promise<boolean> => {
    const title = name.trim();
    const folder = safeFileName(title);
    if (title.length === 0 || folder.length === 0) return false;
    const spacesFolder = spacesFolderOf(space.workspaceRoot);
    const currentFolder = spaceFolderName(space.workspaceRoot);
    if (folder !== currentFolder) {
      const moved = await moveWithin(
        space.environmentId,
        spacesFolder,
        currentFolder,
        folder,
        "Could not rename space",
      );
      if (!moved) return false;
    }
    const workspaceRoot = `${spacesFolder}/${folder}`;
    const updated = await updateSpaceProject(
      space,
      { title, workspaceRoot },
      "Could not rename space",
    );
    if (!updated && folder !== currentFolder) {
      await moveWithin(
        space.environmentId,
        spacesFolder,
        folder,
        currentFolder,
        "Could not rename space",
      );
    }
    return updated;
  };

  /** To the trash: the folder moves under `.trash` and the project follows it, chats included. */
  const deleteSpace = async (space: SpaceRecord): Promise<boolean> => {
    const spacesFolder = spacesFolderOf(space.workspaceRoot);
    const folder = spaceFolderName(space.workspaceRoot);
    const target = `${SPACE_TRASH_DIR}/${trashStamp()}/${folder}`;
    const moved = await moveWithin(
      space.environmentId,
      spacesFolder,
      folder,
      target,
      "Could not delete space",
    );
    if (!moved) return false;
    const updated = await updateSpaceProject(
      space,
      { workspaceRoot: `${spacesFolder}/${target}` },
      "Could not delete space",
    );
    if (!updated) {
      await moveWithin(space.environmentId, spacesFolder, target, folder, "Could not delete space");
    }
    return updated;
  };

  const restoreSpace = async (
    space: SpaceRecord,
    takenFolders: ReadonlySet<string>,
  ): Promise<boolean> => {
    const spacesFolder = spacesFolderOf(space.workspaceRoot);
    const trashed = space.workspaceRoot.slice(spacesFolder.length + 1).replace(/\\/g, "/");
    const folder = uniqueName(spaceFolderName(space.workspaceRoot), takenFolders);
    const moved = await moveWithin(
      space.environmentId,
      spacesFolder,
      trashed,
      folder,
      "Could not restore space",
    );
    if (!moved) return false;
    return updateSpaceProject(
      space,
      { workspaceRoot: `${spacesFolder}/${folder}` },
      "Could not restore space",
    );
  };

  /** Removes the project and its chats; the folder stays in `.trash` on disk. */
  const deleteSpaceForever = async (
    space: Pick<EnvironmentProject, "environmentId" | "id">,
  ): Promise<boolean> => {
    const result = await deleteProject({
      environmentId: space.environmentId,
      input: { projectId: space.id, force: true },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result))
      reportFailure("Could not delete space", failureMessage(result));
    return false;
  };

  const createPage = async (
    space: SpaceRef,
    parentPath: string,
    siblingTitles: ReadonlySet<string>,
  ): Promise<string | null> => {
    const relativePath = childPagePath(parentPath, uniqueName("Untitled", siblingTitles));
    return (await writeSpaceFile(space, relativePath, "")) ? relativePath : null;
  };

  const renamePage = async (
    space: SpaceRef,
    relativePath: string,
    title: string,
    hasChildren: boolean,
  ): Promise<string | null> => {
    const next = childPagePath(pageParentPath(relativePath), title);
    if (next === relativePath) return relativePath;
    if (!(await moveSpaceEntry(space, relativePath, next))) return null;
    if (hasChildren) {
      await moveSpaceEntry(space, pageChildrenDir(relativePath), pageChildrenDir(next));
    }
    return next;
  };

  const deletePage = async (
    space: SpaceRef,
    relativePath: string,
    hasChildren: boolean,
  ): Promise<boolean> => {
    const stamp = `${SPACE_TRASH_DIR}/${trashStamp()}`;
    const moved = await moveSpaceEntry(space, relativePath, `${stamp}/${entryName(relativePath)}`);
    if (!moved) return false;
    if (hasChildren) {
      await moveSpaceEntry(
        space,
        pageChildrenDir(relativePath),
        `${stamp}/${pageTitle(relativePath)}`,
      );
    }
    return true;
  };

  /** Back from `.trash/<stamp>/Title.md` to the top level of pages. */
  const restorePage = async (
    space: SpaceRef,
    trashedPath: string,
    takenTitles: ReadonlySet<string>,
  ): Promise<boolean> => {
    const title = uniqueName(pageTitle(trashedPath), takenTitles);
    const restored = await moveSpaceEntry(space, trashedPath, `${SPACE_PAGES_DIR}/${title}.md`);
    if (!restored) return false;
    // Its subpages folder came along under the same stamp; bring it too when present.
    await moveSpaceEntry(
      space,
      trashedPath.replace(/\.md$/i, ""),
      `${SPACE_PAGES_DIR}/${title}`,
    ).catch(() => false);
    return true;
  };

  return {
    createPage,
    createSpace,
    deletePage,
    deleteSpace,
    deleteSpaceForever,
    moveSpaceEntry,
    renamePage,
    renameSpace,
    restorePage,
    restoreSpace,
    setSpaceAppearance,
    writeSpaceFile,
  };
}
