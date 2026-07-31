export type WebPushIneligibleReason =
  | "INSECURE_CONTEXT"
  | "PWA_INSTALL_REQUIRED"
  | "UNSUPPORTED"
  | "PERMISSION_DENIED";

export interface WebPushEnvironment {
  readonly isSecureContext: boolean;
  readonly isStandalone: boolean;
  readonly hasServiceWorker: boolean;
  readonly hasPushManager: boolean;
  readonly notificationPermission: NotificationPermission;
  readonly userActivationIsActive: boolean;
  readonly requestNotificationPermission: () => Promise<NotificationPermission>;
}

export interface WebPushCapability {
  readonly eligible: boolean;
  readonly installed: boolean;
  readonly permission: NotificationPermission;
  readonly reason: WebPushIneligibleReason | null;
  readonly supported: boolean;
}

export type WebPushClientErrorCode =
  | WebPushIneligibleReason
  | "USER_GESTURE_REQUIRED";

export class WebPushClientError extends Error {
  constructor(
    readonly code: WebPushClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebPushClientError";
  }
}

export function detectWebPushCapability(
  environment: WebPushEnvironment = browserWebPushEnvironment(),
): WebPushCapability {
  const supported =
    environment.hasServiceWorker && environment.hasPushManager;
  let reason: WebPushIneligibleReason | null = null;

  if (!supported) {
    reason = "UNSUPPORTED";
  } else if (!environment.isSecureContext) {
    reason = "INSECURE_CONTEXT";
  } else if (!environment.isStandalone) {
    reason = "PWA_INSTALL_REQUIRED";
  } else if (environment.notificationPermission === "denied") {
    reason = "PERMISSION_DENIED";
  }

  return {
    eligible: reason === null,
    installed: environment.isStandalone,
    permission: environment.notificationPermission,
    reason,
    supported,
  };
}

export async function requestWebPushPermissionFromUserGesture(
  environment: WebPushEnvironment = browserWebPushEnvironment(),
): Promise<NotificationPermission> {
  const capability = detectWebPushCapability(environment);
  if (environment.notificationPermission === "denied") {
    return "denied";
  }
  if (!capability.eligible) {
    throw new WebPushClientError(
      capability.reason ?? "UNSUPPORTED",
      messageForReason(capability.reason ?? "UNSUPPORTED"),
    );
  }
  if (environment.notificationPermission === "granted") {
    return "granted";
  }
  if (!environment.userActivationIsActive) {
    throw new WebPushClientError(
      "USER_GESTURE_REQUIRED",
      "Notification permission must be requested directly from a user action.",
    );
  }
  return environment.requestNotificationPermission();
}

export function browserWebPushEnvironment(): WebPushEnvironment {
  const standaloneNavigator = navigator as Navigator & {
    readonly standalone?: boolean;
  };
  const hasNotification = "Notification" in globalThis;

  return {
    isSecureContext: globalThis.isSecureContext,
    isStandalone:
      globalThis.matchMedia?.("(display-mode: standalone)").matches === true ||
      standaloneNavigator.standalone === true,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in globalThis,
    notificationPermission: hasNotification
      ? Notification.permission
      : "denied",
    userActivationIsActive: navigator.userActivation?.isActive === true,
    requestNotificationPermission: hasNotification
      ? () => Notification.requestPermission()
      : async () => "denied",
  };
}

function messageForReason(reason: WebPushIneligibleReason): string {
  switch (reason) {
    case "INSECURE_CONTEXT":
      return "Web Push requires a secure context.";
    case "PWA_INSTALL_REQUIRED":
      return "Install and open the PWA before enabling notifications.";
    case "PERMISSION_DENIED":
      return "Notification permission is denied in browser settings.";
    case "UNSUPPORTED":
      return "This browser does not support Web Push.";
  }
}
