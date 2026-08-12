import { AttendanceService, type AttendanceStore } from "./attendance-service";
import { DesktopService, type DesktopStore } from "./desktop-service";
import { MobileService, type MobileStore } from "./mobile-service";
import { NotificationService, type NotificationStore } from "./notification-service";
import { PairingService, type PairingStore } from "./pairing-service";
import { PersonalService, type PersonalControlsStore } from "./personal-service";
import { PublicDataService, type PublicDataStorage } from "./public-data-service";
import { PushService, type PushSubscriptionStore } from "./push-service";

export type ApiRenewalStore = AttendanceStore
  & DesktopStore
  & MobileStore
  & NotificationStore
  & PairingStore
  & PersonalControlsStore
  & PushSubscriptionStore;

export interface ApiServices {
  attendance: AttendanceService;
  desktop: DesktopService;
  mobile: MobileService;
  notifications: NotificationService;
  pairings: PairingService;
  personal: PersonalService;
  publicData: PublicDataService;
  push: PushService;
}

/** Composition root for one request; controllers only receive these application services. */
export function createApiServices(renewalStore: ApiRenewalStore, publicStorage: PublicDataStorage): ApiServices {
  return {
    attendance: new AttendanceService(renewalStore),
    desktop: new DesktopService(renewalStore),
    mobile: new MobileService(renewalStore),
    notifications: new NotificationService(renewalStore),
    pairings: new PairingService(renewalStore),
    personal: new PersonalService(renewalStore),
    publicData: new PublicDataService(publicStorage),
    push: new PushService(renewalStore),
  };
}
