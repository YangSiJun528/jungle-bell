import { describe, expect, it } from "vitest";

import {
  kstDateString,
  selectAttendanceCohort,
} from "./cohort-selection.js";

describe("attendance cohort selection", () => {
  it("selects the active cohort with the nearest end date like the legacy app", () => {
    expect(
      selectAttendanceCohort(
        [
          {
            id: "selected",
            isActive: false,
            startDate: "2026-07-01",
            endDate: "2026-08-31",
          },
          {
            id: "upstream-marker",
            isActive: true,
            startDate: "2026-07-01",
            endDate: "2026-09-30",
          },
        ],
        "2026-07-30",
      ),
    ).toEqual({
      cohortId: "selected",
      cohortStatus: "active",
      cohortStartDate: "2026-07-01",
      cohortEndDate: "2026-08-31",
    });
  });

  it("prioritizes bounded upcoming cohorts by end date like the legacy app", () => {
    expect(
      selectAttendanceCohort(
        [
          {
            id: "starts-first",
            isActive: false,
            startDate: "2026-08-01",
            endDate: "2027-12-31",
          },
          {
            id: "ends-first",
            isActive: false,
            startDate: "2026-09-01",
            endDate: "2026-12-31",
          },
          {
            id: "open-ended",
            isActive: false,
            startDate: "2026-07-31",
            endDate: null,
          },
        ],
        "2026-07-30",
      ),
    ).toMatchObject({
      cohortId: null,
      cohortStatus: "upcoming",
      cohortStartDate: "2026-09-01",
      cohortEndDate: "2026-12-31",
    });
  });

  it("reports upcoming, ended, and no-cohort states without a query id", () => {
    expect(
      selectAttendanceCohort(
        [
          {
            id: "next",
            isActive: false,
            startDate: "2026-09-01",
            endDate: null,
          },
        ],
        "2026-07-30",
      ),
    ).toMatchObject({
      cohortId: null,
      cohortStatus: "upcoming",
      cohortStartDate: "2026-09-01",
    });
    expect(
      selectAttendanceCohort(
        [
          {
            id: "past",
            isActive: false,
            startDate: "2026-01-01",
            endDate: "2026-06-30",
          },
        ],
        "2026-07-30",
      ),
    ).toMatchObject({
      cohortId: null,
      cohortStatus: "ended",
      cohortEndDate: "2026-06-30",
    });
    expect(selectAttendanceCohort([], "2026-07-30")).toEqual({
      cohortId: null,
      cohortStatus: "none",
      cohortStartDate: null,
      cohortEndDate: null,
    });
  });

  it("normalizes timezone-qualified LMS dates in Korea time", () => {
    expect(
      selectAttendanceCohort(
        [
          {
            id: "kst",
            isActive: true,
            startDate: "2026-07-29T16:00:00.000Z",
            endDate: "2026-08-31T14:59:59.000Z",
          },
        ],
        "2026-07-30",
      ),
    ).toMatchObject({
      cohortId: "kst",
      cohortStartDate: "2026-07-30",
      cohortEndDate: "2026-08-31",
    });
    expect(kstDateString(Date.parse("2026-07-29T15:00:00.000Z"))).toBe(
      "2026-07-30",
    );
  });

  it("rejects an invalid collector date", () => {
    expect(() => selectAttendanceCohort([], "2026-02-30")).toThrow(
      "ATTENDANCE_DATE_INVALID",
    );
  });
});
