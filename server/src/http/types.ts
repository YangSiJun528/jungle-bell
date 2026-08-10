import type { LmsSessionState, RenewalStore } from "../workers/account-storage";
import type { CloudflareApiStorage } from "../workers/cloudflare-storage";

export interface ApiBindings {
  DB: D1Database;
  DATA_BUCKET: R2Bucket;
  PAIRING_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  JOBS_D1_GATEWAY_SECRET?: string;
  RENEWAL_STORE?: RenewalStore;
}

export type ApiVariables = {
  storage: CloudflareApiStorage;
  renewalStore: RenewalStore;
};

export type ApiEnvironment = { Bindings: ApiBindings; Variables: ApiVariables };

export interface DesktopHeartbeatBody {
  lmsSessionState: LmsSessionState;
  appVersion: string | null;
}
