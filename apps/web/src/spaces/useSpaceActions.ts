import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectIconOverride, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { refreshProjectEntriesQuery } from "../components/files/projectFilesQueryState";
import { toastManager } from "../components/ui/toast";
import { newProjectId } from "../lib/utils";
import { waitForProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { spaceSeedFiles, spaceWorkspaceRoot } from "./spaces";

type SpaceRef = Pick<EnvironmentProject, "environmentId" | "workspaceRoot">;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong.";
}

function parentDirectory(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

function refreshDirectoryOf(space: SpaceRef, relativePath: string) {
  refreshProjectEntriesQuery(
    space.environmentId,
    space.workspaceRoot,
    parentDirectory(relativePath),
  );
}

function reportFailure(title: string, description: string) {
  toastManager.add({ type: "error", title, description });
}

/** Everything that changes a Space: its folder, its project record, its files. */
export function useSpaceActions() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const moveEntry = useAtomCommand(projectEnvironment.moveEntry, { reportFailure: false });

  const writeSpaceFile = useCallback(
    async (
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
        refreshDirectoryOf(space, relativePath);
        return true;
      }
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(`Could not save ${relativePath}`, failureMessage(result));
      }
      return false;
    },
    [writeFile],
  );

  const moveSpaceEntry = useCallback(
    async (space: SpaceRef, relativePath: string, toRelativePath: string): Promise<boolean> => {
      const result = await moveEntry({
        environmentId: space.environmentId,
        input: { cwd: space.workspaceRoot, relativePath, toRelativePath },
      });
      if (result._tag === "Success") {
        refreshDirectoryOf(space, relativePath);
        refreshDirectoryOf(space, toRelativePath);
        return true;
      }
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(`Could not move ${relativePath}`, failureMessage(result));
      }
      return false;
    },
    [moveEntry],
  );

  const setSpaceIcon = useCallback(
    async (space: Pick<EnvironmentProject, "environmentId" | "id">, icon: ProjectIconOverride) => {
      const result = await updateProject({
        environmentId: space.environmentId,
        input: { projectId: space.id, projectIcon: icon, faviconPath: null },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not change the icon", failureMessage(result));
      }
    },
    [updateProject],
  );

  const createSpace = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly icon: ProjectIconOverride;
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
          reportFailure("Could not create the Space", failureMessage(created));
        }
        return null;
      }
      // The server expands `~`; file writes need the absolute folder it stored.
      const project = await waitForProject(scopeProjectRef(input.environmentId, projectId));
      for (const file of spaceSeedFiles(input.name)) {
        if (!(await writeSpaceFile(project, file.relativePath, file.contents))) return null;
      }
      await setSpaceIcon(project, input.icon);
      return projectId;
    },
    [createProject, setSpaceIcon, writeSpaceFile],
  );

  return { createSpace, moveSpaceEntry, setSpaceIcon, writeSpaceFile };
}
