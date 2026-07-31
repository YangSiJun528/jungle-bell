import { describe, expect, it } from "vitest";

import { shouldPollPairing } from "./pairing-poll";

describe("shouldPollPairing", () => {
  it("stops after approval or completion", () => {
    expect(shouldPollPairing("approved")).toBe(false);
    expect(shouldPollPairing("completed")).toBe(false);
  });

  it("keeps checking while the phone has not been approved", () => {
    expect(shouldPollPairing("pending")).toBe(true);
    expect(shouldPollPairing("claimed")).toBe(true);
  });
});
