import type { RunAttemptId, RunId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  hasLiveClientTimelineStateRisk,
  rememberTimelinePosition,
} from "./timelineScrollAnchoring";

it("preserves nondefault cached views and mutable disclosures in other threads", () => {
  const visible = "live-client-visible";
  const prior = "live-client-remembered";
  const disclosures = {
    runs: new Set<RunId>(),
    workGroups: new Set<string>(),
    attempts: new Set<RunAttemptId>(),
    workGroupState: {
      scrollPositions: new Map<string, { entryId: string; offset: number }>(),
      expandedEntries: new Set<string>(),
    },
  };
  const position = {
    rowId: "entry",
    offsetWithinRow: 0,
    scrollOffset: 0,
    atEnd: false,
    disclosures,
  };
  rememberTimelinePosition(prior, position, false);
  expect(hasLiveClientTimelineStateRisk(visible)).toBe(true);
  expect(hasLiveClientTimelineStateRisk(prior)).toBe(false);
  rememberTimelinePosition(prior, { ...position, atEnd: true }, true);
  expect(hasLiveClientTimelineStateRisk(visible)).toBe(false);
  disclosures.workGroups.add("expanded-group");
  expect(hasLiveClientTimelineStateRisk(visible)).toBe(true);
  disclosures.workGroups.clear();
  disclosures.workGroupState.expandedEntries.add("nested-entry");
  expect(hasLiveClientTimelineStateRisk(visible)).toBe(true);
  disclosures.workGroupState.expandedEntries.clear();
  disclosures.workGroupState.scrollPositions.set("group", { entryId: "nested-entry", offset: 40 });
  expect(hasLiveClientTimelineStateRisk(visible)).toBe(true);
  disclosures.workGroupState.scrollPositions.clear();
  expect(hasLiveClientTimelineStateRisk(visible)).toBe(false);
});
