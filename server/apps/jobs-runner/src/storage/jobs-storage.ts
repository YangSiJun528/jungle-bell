import { D1RenewalStore } from "@jungle-bell/backend-common/persistence/d1-renewal-store";
import type { RenewalStore } from "@jungle-bell/backend-common/ports/account-storage";
import type { CollectorStorage } from "@jungle-bell/backend-common/ports/collector-storage";
import { CloudflareRestStorage, type CloudflareRestStorageOptions } from "./cloudflare-rest-storage";
import { D1GatewayDatabase, type D1GatewayDatabaseOptions } from "./d1-gateway-database";

/** Storage dependencies exposed to workers and services without leaking DB setup. */
export interface JobsStorage {
  collector: CollectorStorage;
  renewal: RenewalStore;
}

interface JobsStorageConfiguration {
  d1: D1GatewayDatabaseOptions;
  storage: CloudflareRestStorageOptions;
}

export function createJobsStorage(
  configuration: JobsStorageConfiguration,
): JobsStorage {
  const database = new D1GatewayDatabase(configuration.d1);
  return {
    collector: new CloudflareRestStorage(configuration.storage, { d1: database }),
    renewal: new D1RenewalStore(database),
  };
}
