import { useAtomValue } from "@effect/atom-react";
import { createThreadFamilyAtoms } from "@t3tools/client-runtime/state/threads";
import { EMPTY_SHELL_STATE, presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2SearchThreadsInput,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useComposerMenuItems } from "./useComposerMenuItems";

const state = vi.hoisted(() => ({
  families: null as unknown as ReturnType<typeof createThreadFamilyAtoms>,
  older: null as unknown as ReturnType<
    typeof import("../../state/threads").olderSettledThreads.olderSettledAtom
  >,
  shells: null as unknown as Atom.Atom<ReadonlyArray<ReturnType<typeof presentThreadShell>>>,
  search: null as unknown as (
    environmentId: EnvironmentId,
    input: OrchestrationV2SearchThreadsInput,
  ) => ReturnType<typeof import("../../state/threads").olderSettledThreads.searchAtom>,
}));

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: {
      ...actual.threadFamilies,
      mountRows: (...args: Parameters<typeof actual.threadFamilies.mountRows>) =>
        state.families.mountRows(...args),
    },
    olderSettledThreads: {
      ...actual.olderSettledThreads,
      olderSettledAtom: () => state.older,
      searchAtom: (environmentId: EnvironmentId, input: OrchestrationV2SearchThreadsInput) =>
        state.search(environmentId, input),
    },
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useVisibleThreadShells: () => useAtomValue(state.shells),
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentities: () => [],
  useEnvironmentMachines: () => new Map(),
}));
vi.mock(import("../../state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: false, isPending: false, error: null }),
}));

const own = EnvironmentId.make("mention-own");
const linked = EnvironmentId.make("mention-linked");
const unlinked = EnvironmentId.make("mention-unlinked");

function setup() {
  const thread = makeThreadProjectionFixture().thread;
  const olderThread: OrchestrationV2ThreadShell = {
    ...thread,
    id: ThreadId.make("older-linked-thread"),
    title: "Deploy linked service",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
  };
  const snapshot: OrchestrationV2ShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [],
    threads: [],
    archivedThreads: [],
  };
  const shell = Atom.make(
    AsyncResult.success({
      ...EMPTY_SHELL_STATE,
      status: "live" as const,
      generation: 1,
      snapshot: Option.some(snapshot),
    }),
  );
  state.families = createThreadFamilyAtoms(Atom.runtime(Layer.empty) as never, () => shell);
  state.older = Atom.make({
    before: "2026-10-01T00:00:00.000Z",
    beforeMs: Date.parse("2026-10-01T00:00:00.000Z"),
    counts: new Map([[thread.projectId, 1]]),
  });
  const replies = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      AsyncResult.success({
        matches: [],
        snapshotSequence: 1,
        threads:
          environmentId === own
            ? []
            : [
                {
                  ...olderThread,
                  title: environmentId === linked ? olderThread.title : "Deploy unlinked service",
                },
              ],
      }),
    ),
  );
  state.search = (environmentId) => replies(environmentId);
  state.shells = Atom.make((get) =>
    [own, linked, unlinked].flatMap((environmentId) =>
      (get(state.families.snapshotAtom(environmentId))?.threads ?? []).map((row) =>
        presentThreadShell(environmentId, row),
      ),
    ),
  );
}

function MentionResults() {
  const { items } = useComposerMenuItems({
    composerTrigger: { kind: "path", query: "deploy", rangeStart: 0, rangeEnd: 7 },
    environmentId: own,
    linkedEnvironments: new Map([[linked, "Linked machine"]]),
    gitCwd: null,
    activeThreadId: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: [],
    sideChatAvailable: false,
    sideChatDisabledReason: null,
    freshSessionAvailable: false,
    compactSlashCommandAvailable: false,
    selectedProvider: ProviderDriverKind.make("codex"),
    selectedProviderSkills: [],
    selectedProviderSlashCommands: [],
    showSkillsInSlashMenu: false,
    workspaceSkillsScanning: false,
    questionAttachmentTarget: null,
    modelMentions: { instanceEntries: [], modelOptionsByInstance: new Map() },
  });
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
    </ul>
  );
}

it("offers an older settled thread on a linked machine after its omitted row is searched", async () => {
  setup();
  await using screen = await render(
    <AppAtomRegistryProvider>
      <MentionResults />
    </AppAtomRegistryProvider>,
  );
  await expect.element(screen.getByText("Deploy linked service")).toBeVisible();
  await expect.element(screen.getByText("Deploy unlinked service")).not.toBeInTheDocument();
});
