import { assert, describe, it } from "@effect/vitest";

import {
  classifyLaneFailure,
  deakinSignIn,
  microsoftSignIn,
  normalizeOnTrackOverview,
  normalizeOnTrackTaskDetails,
  normalizeTeamsThreads,
} from "./normalize.ts";

describe("classifyLaneFailure", () => {
  it("sorts lane messages into what a page can do about them", () => {
    assert.equal(
      classifyLaneFailure(
        "Microsoft browser broker is required but is not running on 127.0.0.1:9223.",
      ),
      "lane_offline",
    );
    assert.equal(
      classifyLaneFailure(
        "No valid Outlook Mail session found, and assisted Microsoft sign-in did not complete.",
      ),
      "sign_in_required",
    );
    assert.equal(
      classifyLaneFailure(
        "Deakin needs an interactive sign-in before live portal actions can continue.",
      ),
      "sign_in_required",
    );
    assert.equal(classifyLaneFailure("Timed out waiting for the task page."), "tool_failed");
  });
});

describe("sign-in state", () => {
  it("reads each Deakin portal separately", () => {
    assert.deepEqual(
      deakinSignIn({
        portals: { ontrack: { authenticated: true }, deakinsync: { authenticated: false } },
      }),
      { ontrack: true, deakinsync: false },
    );
    assert.deepEqual(deakinSignIn({}), { ontrack: false, deakinsync: false });
  });

  it("keeps Teams signed in when only mail and calendar are missing", () => {
    assert.deepEqual(microsoftSignIn({ ok: true, message: null }), { teams: true, outlook: true });
    assert.deepEqual(
      microsoftSignIn({
        ok: false,
        message:
          "Microsoft web session is incomplete. Missing: mail, calendar. Run the local Microsoft login flow first.",
      }),
      { teams: true, outlook: false },
    );
    assert.deepEqual(microsoftSignIn({ ok: false, message: "Missing: teams." }), {
      teams: false,
      outlook: true,
    });
    assert.deepEqual(microsoftSignIn({ ok: false, message: "Broker is not running." }), {
      teams: false,
      outlook: false,
    });
  });
});

describe("OnTrack", () => {
  const unit = {
    projectId: 178581,
    unitCode: "SIT313",
    unitName: "Full Stack Development",
    teachingPeriod: "T2 2026",
    startDate: "2026-07-06",
    endDate: "2026-10-16",
    isCurrent: true,
  };
  const task = {
    projectId: 178581,
    taskId: 2009387,
    taskDefinitionId: 21390,
    unitCode: "SIT313",
    taskAbbreviation: "C1",
    taskName: "New Post Page",
    status: "fix_and_resubmit",
    dueDate: null,
    taskDefinitionDueDate: "2026-09-11",
    extensions: 0,
    timesAssessed: 1,
    newComments: 2,
    hasTaskSheet: true,
    uploadRequirements: [{ name: "report.pdf", type: "document" }, { nope: true }],
  };

  it("shapes the overview and keeps the lane's cache note", () => {
    const overview = normalizeOnTrackOverview({
      units: { units: [unit, { unitCode: "broken" }] },
      projects: [
        {
          project: { projectId: 178581, targetGrade: 3, submittedGrade: null },
          tasks: [{ ...task, taskTargetGrade: 1, taskDefinition: { weighting: 5 } }],
          cache: {
            cached: true,
            cachedAt: "2026-08-31T02:07:28.064Z",
            liveError: "Microsoft browser broker is required but is not running on 127.0.0.1:9223.",
          },
        },
      ],
      fetchedAt: "2026-10-08T12:00:00.000Z",
    });
    assert.equal(overview.units.length, 1);
    assert.equal(overview.units[0]?.targetGrade, 3);
    assert.equal(overview.tasks[0]?.dueDate, "2026-09-11");
    assert.equal(overview.tasks[0]?.uploadRequirements.length, 1);
    assert.equal(overview.tasks[0]?.targetGrade, 1);
    assert.equal(overview.tasks[0]?.weighting, 5);
    assert.deepEqual(overview.meta, {
      fetchedAt: "2026-08-31T02:07:28.064Z",
      stale: true,
      note: "Microsoft browser broker is required but is not running on 127.0.0.1:9223.",
      issue: "lane_offline",
    });
  });

  it("shapes task details from the lane's envelope", () => {
    const details = normalizeOnTrackTaskDetails({
      raw: {
        payload: {
          task: { ...task, taskDescription: "Report on the page" },
          taskDefinition: { description: "Build the page", weighting: 5, targetGrade: 3 },
          comments: [
            {
              commentId: 1,
              type: "text",
              text: "Looks good",
              createdAt: "2026-09-01T00:00:00.000Z",
              author: { name: "Tutor" },
            },
            { type: "text", text: "no id" },
          ],
          submission: { submissionDate: "2026-09-02", taskStatus: "complete", hasPdf: true },
          taskPagePath: "/projects/178581/dashboard/C1",
        },
      },
      fetchedAt: "2026-10-08T12:00:00.000Z",
    });
    assert.ok(details);
    assert.equal(details.description, "Build the page");
    assert.equal(details.weighting, 5);
    assert.deepEqual(
      details.comments.map((comment) => comment.author),
      ["Tutor"],
    );
    assert.equal(details.submission?.hasPdf, true);
    assert.equal(details.meta.stale, false);
    assert.equal(normalizeOnTrackTaskDetails({ raw: {}, fetchedAt: "x" }), null);
  });
});

describe("Teams", () => {
  it("reads threads and the cursor for the next page", () => {
    const result = normalizeTeamsThreads({
      raw: {
        threads: [{ ref: "msui1.abc", title: "SIT313", unread: true }, {}],
        pagination: { nextCursor: "msc1.eyJvZmZzZXQiOjV9" },
      },
      fetchedAt: "2026-10-08T12:00:00.000Z",
    });
    assert.equal(result.threads.length, 2);
    assert.equal(result.threads[0]?.title, "SIT313");
    assert.equal(result.threads[1]?.title, null);
    assert.equal(result.nextCursor, "msc1.eyJvZmZzZXQiOjV9");
  });
});
