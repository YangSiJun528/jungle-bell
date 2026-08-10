import { describe, expect, it, vi } from "vitest";
import { runIndependentScheduledTasks } from "../src/application/scheduled-renewal";

describe("scheduled renewal isolation", () => {
  it("records a failed planner and still runs later lifecycle work and Push delivery last", async () => {
    const calls: string[] = [];
    const onError = vi.fn();
    const result = await runIndependentScheduledTasks([
      { name: "attendance", run: async () => { calls.push("attendance"); throw new Error("broken snapshot"); } },
      { name: "meals", run: async () => { calls.push("meals"); } },
      { name: "laundry", run: async () => { calls.push("laundry"); } },
      { name: "housekeeping", run: async () => { calls.push("housekeeping"); } },
      { name: "push", run: async () => { calls.push("push"); } },
    ], onError);

    expect(calls).toEqual(["attendance", "meals", "laundry", "housekeeping", "push"]);
    expect(result).toEqual({ succeeded: ["meals", "laundry", "housekeeping", "push"], failed: ["attendance"] });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("attendance", expect.objectContaining({ message: "broken snapshot" }));
  });
});
