import type { MobilePairingStatus } from "./api-client";

export function shouldPollPairing(
  status: MobilePairingStatus["status"],
): boolean {
  return status === "pending" || status === "claimed";
}
