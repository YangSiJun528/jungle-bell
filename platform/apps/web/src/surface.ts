export type SurfaceKind = "public" | "desktop" | "companion";

export interface SurfaceCapabilities {
  kind: SurfaceKind;
  canManageLmsSession: boolean;
  canPair: boolean;
  canReceivePersonalNotifications: boolean;
  canViewAttendance: boolean;
}

const PUBLIC: SurfaceCapabilities = {
  kind: "public",
  canManageLmsSession: false,
  canPair: false,
  canReceivePersonalNotifications: false,
  canViewAttendance: false,
};

export function resolveSurface(
  path: string,
  runningInTauri: boolean,
): SurfaceCapabilities {
  if (runningInTauri) {
    return {
      kind: "desktop",
      canManageLmsSession: true,
      canPair: true,
      canReceivePersonalNotifications: true,
      canViewAttendance: true,
    };
  }

  if (path.startsWith("/app") || path.startsWith("/pair")) {
    return {
      kind: "companion",
      canManageLmsSession: false,
      canPair: false,
      canReceivePersonalNotifications: true,
      canViewAttendance: true,
    };
  }

  return PUBLIC;
}
