import type { RenewalStore } from "@jungle-bell/backend-common/ports/account-storage";
import type { ApiServices } from "../services/api-services";
import type { Principal } from "../domain/session";

export interface ApiBindings {
  DB: D1Database;
  DATA_BUCKET: R2Bucket;
  PAIRING_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  JOBS_D1_GATEWAY_SECRET?: string;
  RENEWAL_STORE?: RenewalStore;
}

export type ApiVariables = {
  services: ApiServices;
  desktopUiPrincipal: Principal;
};

export type ApiEnvironment = { Bindings: ApiBindings; Variables: ApiVariables };
