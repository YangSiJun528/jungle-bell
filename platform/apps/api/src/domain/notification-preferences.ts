import type { Clock } from "./ports.js";

export interface MealNotificationPreferences {
  readonly breakfast: boolean;
  readonly lunch: boolean;
  readonly dinner: boolean;
}

export interface LaundryNotificationPreferences {
  readonly notifyWhenAvailable: boolean;
  readonly selectedMachineIds: readonly string[];
}

export interface NotificationPreferences {
  readonly userId: string;
  readonly deviceId: string;
  readonly meals: MealNotificationPreferences;
  readonly laundry: LaundryNotificationPreferences;
  readonly updatedAtEpochMs: number;
}

export interface NotificationPreferenceStore {
  get(
    userId: string,
    deviceId: string,
  ): Promise<NotificationPreferences | null>;
  upsert(preferences: NotificationPreferences): Promise<void>;
}

export class NotificationPreferenceDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NotificationPreferenceDomainError";
  }
}

export class InMemoryNotificationPreferenceStore
  implements NotificationPreferenceStore
{
  private readonly preferences = new Map<string, NotificationPreferences>();

  async get(
    userId: string,
    deviceId: string,
  ): Promise<NotificationPreferences | null> {
    const stored = this.preferences.get(preferenceKey(userId, deviceId));
    return stored ? clonePreferences(stored) : null;
  }

  async upsert(preferences: NotificationPreferences): Promise<void> {
    this.preferences.set(
      preferenceKey(preferences.userId, preferences.deviceId),
      clonePreferences(preferences),
    );
  }
}

export class NotificationPreferenceService {
  constructor(
    private readonly dependencies: {
      readonly clock: Clock;
      readonly store: NotificationPreferenceStore;
    },
  ) {}

  async put(input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly meals: {
      readonly breakfast: boolean;
      readonly lunch: boolean;
      readonly dinner: boolean;
    };
    readonly laundry: {
      readonly notifyWhenAvailable: boolean;
      readonly selectedMachineIds: readonly string[];
    };
  }): Promise<NotificationPreferences> {
    assertIdentifier(input.userId);
    assertIdentifier(input.deviceId);
    assertBoolean(input.meals?.breakfast);
    assertBoolean(input.meals?.lunch);
    assertBoolean(input.meals?.dinner);
    assertBoolean(input.laundry?.notifyWhenAvailable);
    if (
      !Array.isArray(input.laundry?.selectedMachineIds) ||
      input.laundry.selectedMachineIds.length > 256
    ) {
      throw invalidPreferences();
    }

    const selectedMachineIds = input.laundry.selectedMachineIds.map(
      normalizeMachineId,
    );
    const preferences: NotificationPreferences = {
      userId: input.userId,
      deviceId: input.deviceId,
      meals: {
        breakfast: input.meals.breakfast,
        lunch: input.meals.lunch,
        dinner: input.meals.dinner,
      },
      laundry: {
        notifyWhenAvailable: input.laundry.notifyWhenAvailable,
        selectedMachineIds: [...new Set(selectedMachineIds)].sort(),
      },
      updatedAtEpochMs: this.dependencies.clock.now(),
    };
    await this.dependencies.store.upsert(preferences);
    return clonePreferences(preferences);
  }

  async get(
    userId: string,
    deviceId: string,
  ): Promise<NotificationPreferences> {
    assertIdentifier(userId);
    assertIdentifier(deviceId);
    const stored = await this.dependencies.store.get(userId, deviceId);
    if (stored) {
      return stored;
    }

    return {
      userId,
      deviceId,
      meals: {
        breakfast: false,
        lunch: false,
        dinner: false,
      },
      laundry: {
        notifyWhenAvailable: false,
        selectedMachineIds: [],
      },
      updatedAtEpochMs: this.dependencies.clock.now(),
    };
  }
}

function clonePreferences(
  preferences: NotificationPreferences,
): NotificationPreferences {
  return {
    ...preferences,
    meals: { ...preferences.meals },
    laundry: {
      ...preferences.laundry,
      selectedMachineIds: [...preferences.laundry.selectedMachineIds],
    },
  };
}

function preferenceKey(userId: string, deviceId: string): string {
  return JSON.stringify([userId, deviceId]);
}

function assertIdentifier(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw invalidPreferences();
  }
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw invalidPreferences();
  }
}

function normalizeMachineId(value: string): string {
  if (typeof value !== "string") {
    throw invalidPreferences();
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 128) {
    throw invalidPreferences();
  }
  return normalized;
}

function invalidPreferences(): NotificationPreferenceDomainError {
  return new NotificationPreferenceDomainError(
    "INVALID_NOTIFICATION_PREFERENCES",
    "Notification preferences are invalid.",
  );
}
