const PUSH_SUBSCRIPTION_STORAGE_KEY =
  "jungle-bell.push-subscription-id";
const PUSH_SUBSCRIPTION_ID_PATTERN = /^jbps_[0-9a-f]{64}$/u;

export function readStoredPushSubscriptionId(): string | null {
  try {
    const value = window.localStorage.getItem(
      PUSH_SUBSCRIPTION_STORAGE_KEY,
    );
    return value && PUSH_SUBSCRIPTION_ID_PATTERN.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

export function storePushSubscriptionId(value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(PUSH_SUBSCRIPTION_STORAGE_KEY);
    } else if (PUSH_SUBSCRIPTION_ID_PATTERN.test(value)) {
      window.localStorage.setItem(
        PUSH_SUBSCRIPTION_STORAGE_KEY,
        value,
      );
    } else {
      throw new TypeError("PUSH_SUBSCRIPTION_ID_INVALID");
    }
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "PUSH_SUBSCRIPTION_ID_INVALID"
    ) {
      throw error;
    }
    // Browser storage can be unavailable in private or restricted contexts.
  }
}

export async function clearBrowserPushState(): Promise<boolean> {
  let unsubscribed = true;
  try {
    if ("serviceWorker" in navigator) {
      const registration =
        await navigator.serviceWorker.getRegistration();
      const subscription =
        await registration?.pushManager.getSubscription();
      unsubscribed =
        subscription === undefined ||
        subscription === null ||
        (await subscription.unsubscribe());
    }
  } catch {
    unsubscribed = false;
  }
  // The opaque server identifier must never survive an account switch,
  // including when browser unsubscribe itself fails.
  storePushSubscriptionId(null);
  return unsubscribed;
}
