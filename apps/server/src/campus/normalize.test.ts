import { assert, describe, it } from "@effect/vitest";

import {
  classifyLaneFailure,
  currentProjects,
  deakinSignIn,
  microsoftSignIn,
  normalizeOnTrackApiOverview,
  normalizeOnTrackApiTask,
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

describe("OnTrack API", () => {
  const unit = {
    id: 1012,
    code: "SIT314",
    name: "Software Architecture",
    teaching_period_id: 47,
    task_definitions: [
      {
        id: 21406,
        abbreviation: "6.4HD",
        name: "Applying the State of the Art",
        description: "Report",
        weighting: 5,
        target_grade: 3,
        target_date: "2026-09-27",
        due_date: "2026-10-04",
        start_date: "2026-09-21",
        has_task_sheet: true,
        upload_requirements: [{ key: "file0", name: "report", type: "document" }],
      },
    ],
  };
  const project = {
    id: 178583,
    unit_id: 1012,
    target_grade: 3,
    submitted_grade: 3,
    unit: { id: 1012, code: "SIT314", teaching_period_id: 47, active: true },
    tasks: [
      {
        id: 2074581,
        task_definition_id: 21406,
        status: "ready_for_feedback",
        due_date: "2026-10-04",
        submission_date: "2026-10-04",
        extensions: 1,
        times_assessed: 0,
        num_new_comments: 2,
      },
      { id: 999, task_definition_id: 404, status: "not_started" },
    ],
  };
  const periods = [
    {
      id: 47,
      period: "T2",
      year: 2026,
      start_date: "2026-07-06T00:00:00.000Z",
      end_date: "2026-10-16T00:00:00.000Z",
      active: true,
    },
  ];
  const fetchedAt = "2026-10-09T00:00:00.000Z";

  it("joins projects with their unit's task definitions and the period", () => {
    const overview = normalizeOnTrackApiOverview({
      projects: [{ project, unit }],
      periods,
      fetchedAt,
    });
    assert.deepEqual(overview.units, [
      {
        projectId: 178583,
        unitCode: "SIT314",
        unitName: "Software Architecture",
        teachingPeriod: "T2 2026",
        startDate: "2026-07-06T00:00:00.000Z",
        endDate: "2026-10-16T00:00:00.000Z",
        isCurrent: true,
        targetGrade: 3,
        submittedGrade: 3,
      },
    ]);
    assert.equal(overview.tasks.length, 2);
    const task = overview.tasks[0];
    assert.equal(task?.taskAbbreviation, "6.4HD");
    assert.equal(task?.taskName, "Applying the State of the Art");
    assert.equal(task?.targetGrade, 3);
    assert.equal(task?.weighting, 5);
    assert.equal(task?.newComments, 2);
    assert.equal(task?.uploadRequirements[0]?.name, "report");
    // A task whose definition is unknown keeps its row with empty names.
    assert.equal(overview.tasks[1]?.taskName, "");
    assert.equal(overview.meta.stale, false);
  });

  it("shapes a task's comments and submission", () => {
    const overview = normalizeOnTrackApiOverview({
      projects: [{ project, unit }],
      periods,
      fetchedAt,
    });
    const details = normalizeOnTrackApiTask({
      task: overview.tasks[0]!,
      definition: unit.task_definitions[0],
      comments: [
        {
          id: 10388802,
          comment: "Ready to Mark",
          type: "status",
          is_new: false,
          author: { first_name: "Romil", last_name: "Bijarnia" },
          created_at: "2026-10-04T05:26:04.000Z",
          status: "ready_for_feedback",
        },
        { comment: "no id" },
      ],
      submission: {
        has_pdf: true,
        submission_date: "2026-10-04T04:44:32.000Z",
        task_status: "ready_for_feedback",
      },
      fetchedAt,
    });
    assert.equal(details.description, "Report");
    assert.deepEqual(
      details.comments.map((comment) => [comment.author, comment.text, comment.status]),
      [["Romil Bijarnia", "Ready to Mark", "ready_for_feedback"]],
    );
    assert.equal(details.submission?.hasPdf, true);
    assert.equal(details.taskPagePath, "/projects/178583/dashboard/6.4HD");
  });
});

describe("currentProjects", () => {
  const periods = [
    {
      id: 18,
      period: "T2",
      year: 2022,
      start_date: "2022-07-11T00:00:00.000Z",
      end_date: "2022-10-21T00:00:00.000Z",
      active_until: "2022-11-04T00:00:00.000Z",
      active: false,
    },
    {
      id: 47,
      period: "T2",
      year: 2026,
      start_date: "2026-07-06T00:00:00.000Z",
      end_date: "2026-10-16T00:00:00.000Z",
      active_until: "2026-10-30T00:00:00.000Z",
      active: true,
    },
    {
      id: 48,
      period: "T3",
      year: 2026,
      start_date: "2026-11-02T00:00:00.000Z",
      end_date: "2027-02-12T00:00:00.000Z",
      active_until: "2027-03-01T00:00:00.000Z",
      active: true,
    },
  ];
  const unit = (id: number, code: string, period: number, start: string, end: string) => ({
    id: id * 10,
    unit_id: id,
    unit: { id, code, teaching_period_id: period, start_date: start, end_date: end, active: true },
  });
  const list = [
    unit(1, "SIT192", 18, "2022-07-11", "2022-10-21"),
    unit(2, "SIT313", 47, "2026-07-06", "2026-10-16"),
    unit(3, "SIT314", 47, "2026-07-06", "2026-10-16"),
    unit(4, "SIT374", 48, "2026-11-02", "2027-02-12"),
  ];
  const at = (iso: string) => Date.parse(iso);

  it("keeps the units whose dates cover today, not every unit OnTrack still flags active", () => {
    assert.deepEqual(
      currentProjects(list, periods, at("2026-10-09T00:00:00Z")).map((entry) => entry.unitId),
      [2, 3],
    );
  });

  it("counts marking weeks through the period's active_until", () => {
    assert.deepEqual(
      currentProjects(list, periods, at("2026-10-25T00:00:00Z")).map((entry) => entry.unitId),
      [2, 3],
    );
  });

  it("falls back to the most recently finished units between trimesters", () => {
    assert.deepEqual(
      currentProjects(list, periods, at("2026-11-01T12:00:00Z")).map((entry) => entry.unitId),
      [2, 3],
    );
    assert.deepEqual(
      currentProjects(list, periods, at("2026-11-03T00:00:00Z")).map((entry) => entry.unitId),
      [4],
    );
  });
});
