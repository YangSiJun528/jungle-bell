import { describe, expect, it } from "vitest";

import { parsePairingFragment } from "./pairing-link";

describe("parsePairingFragment", () => {
  it("reads the one-time pairing values from the URL fragment", () => {
    expect(
      parsePairingFragment(
        "#pairing=p_123&challenge=VGVzdENoYWxsZW5nZQ",
      ),
    ).toEqual({
      pairingId: "p_123",
      challenge: "VGVzdENoYWxsZW5nZQ",
    });
  });

  it("rejects malformed identifiers and short challenges", () => {
    expect(parsePairingFragment("#pairing=../x&challenge=short")).toBeNull();
    expect(parsePairingFragment("")).toBeNull();
  });
});
