import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { LG_RUN_STATE_BASELINE, normalizeLgEnum, type NormalizedEnum } from "./lg-profile";
import type { JsonValue, LaundryEvent } from "./types";

const logger = getLogger(["jungle-bell", "collector", "laundry"]);

const timerSchema = z.looseObject({
  remainHour: z.number().int().nonnegative().default(0),
  remainMinute: z.number().int().nonnegative().default(0),
  totalHour: z.number().int().nonnegative().default(0),
  totalMinute: z.number().int().nonnegative().default(0),
});

const applianceSchema = z.looseObject({
  runState: z.looseObject({ currentState: z.string() }),
  timer: timerSchema.default({
    remainHour: 0,
    remainMinute: 0,
    totalHour: 0,
    totalMinute: 0,
  }),
  remoteControlEnable: z.looseObject({
    remoteControlEnabled: z.boolean().nullable().optional(),
  }).optional(),
  cycle: z.looseObject({ cycleCount: z.number().int().nullable().optional() }).optional(),
  error: z.string().nullable().optional(),
});

const towerSchema = z.looseObject({
  washer: applianceSchema.optional(),
  dryer: applianceSchema.optional(),
});

const laundryResponseSchema = z.record(z.string(), towerSchema);

export type ApplianceKind = "washer" | "dryer";
export type OperationalStatus =
  | "IDLE"
  | "SCHEDULED"
  | "RUNNING"
  | "PAUSED"
  | "ERROR"
  | "COMPLETED"
  | "UNKNOWN";

export interface LaundryApplianceSnapshot {
  machineId: string;
  appliance: ApplianceKind;
  observedAt: string;
  state: NormalizedEnum;
  operationalStatus: OperationalStatus;
  remainingMinutes: number;
  totalMinutes: number;
  estimatedFinishAt: string | null;
  remoteControlEnabled: boolean | null;
  cycleCount: number | null;
  sessionId: string | null;
  errorCode: string | null;
}

export interface LaundryMachineSnapshot {
  id: string;
  washer: LaundryApplianceSnapshot | null;
  dryer: LaundryApplianceSnapshot | null;
}

export interface UnknownEnumObservation {
  machineId: string;
  appliance: ApplianceKind;
  fieldPath: string;
  value: string;
}

export interface LaundryVersion {
  schemaVersion: 1;
  sourceVersionSha: string;
  observedAt: string;
  machines: LaundryMachineSnapshot[];
  events: LaundryEvent[];
  unknownEnums: UnknownEnumObservation[];
}

export function toPublicLaundryAppliance(appliance: LaundryApplianceSnapshot): LaundryApplianceSnapshot {
  return {
    machineId: appliance.machineId,
    appliance: appliance.appliance,
    observedAt: appliance.observedAt,
    state: {
      code: appliance.state.code,
      raw: appliance.state.raw,
      known: appliance.state.known,
    },
    operationalStatus: appliance.operationalStatus,
    remainingMinutes: appliance.remainingMinutes,
    totalMinutes: appliance.totalMinutes,
    estimatedFinishAt: appliance.estimatedFinishAt,
    remoteControlEnabled: appliance.remoteControlEnabled,
    cycleCount: appliance.cycleCount,
    sessionId: appliance.sessionId,
    errorCode: appliance.errorCode,
  };
}

export function toPublicLaundryVersion(version: LaundryVersion): LaundryVersion {
  return {
    schemaVersion: version.schemaVersion,
    sourceVersionSha: version.sourceVersionSha,
    observedAt: version.observedAt,
    machines: version.machines.map((machine) => ({
      id: machine.id,
      washer: machine.washer ? toPublicLaundryAppliance(machine.washer) : null,
      dryer: machine.dryer ? toPublicLaundryAppliance(machine.dryer) : null,
    })),
    events: version.events,
    unknownEnums: version.unknownEnums,
  };
}

export interface NormalizeLaundryOptions {
  knownRunStates?: readonly string[];
}

function minutes(timer: z.infer<typeof timerSchema>, prefix: "remain" | "total"): number {
  return timer[`${prefix}Hour`] * 60 + timer[`${prefix}Minute`];
}

function operationalStatus(state: NormalizedEnum, remaining: number, error: string | null): OperationalStatus {
  if (!state.known) return "UNKNOWN";
  if (state.code === "ERROR" || error) return "ERROR";
  if (state.code === "PAUSE") return "PAUSED";
  if (state.code === "END") return "COMPLETED";
  if (state.code === "POWER_OFF" || state.code === "INITIAL") return "IDLE";
  if (state.code === "RESERVED") return "SCHEDULED";
  return remaining > 0 || state.code !== "POWER_OFF" ? "RUNNING" : "IDLE";
}

function previousAppliance(
  previous: LaundryVersion | null,
  machineId: string,
  appliance: ApplianceKind,
): LaundryApplianceSnapshot | null {
  const machine = previous?.machines.find((candidate) => candidate.id === machineId);
  return machine?.[appliance] ?? null;
}

function sessionId(
  machineId: string,
  appliance: ApplianceKind,
  status: OperationalStatus,
  cycleCount: number | null,
  observedAt: string,
  previous: LaundryApplianceSnapshot | null,
): string | null {
  const terminal = status === "IDLE" || status === "COMPLETED";
  if (terminal) return previous?.sessionId ?? null;
  if (appliance === "washer" && cycleCount !== null) return `${machineId}:washer:cycle:${cycleCount}`;
  if (previous?.sessionId && previous.operationalStatus !== "IDLE" && previous.operationalStatus !== "COMPLETED") {
    return previous.sessionId;
  }
  return `${machineId}:${appliance}:${observedAt}`;
}

function normalizeAppliance(
  machineId: string,
  appliance: ApplianceKind,
  raw: z.infer<typeof applianceSchema>,
  observedAt: string,
  knownStates: ReadonlySet<string>,
  previous: LaundryApplianceSnapshot | null,
  unknownEnums: UnknownEnumObservation[],
): LaundryApplianceSnapshot {
  const state = normalizeLgEnum(raw.runState.currentState, knownStates);
  if (!state.known) {
    const unknown = {
      machineId,
      appliance,
      fieldPath: `${appliance}.runState.currentState`,
      value: raw.runState.currentState,
    };
    unknownEnums.push(unknown);
    logger.warn("Unknown LG ThinQ enum value", unknown);
  }

  const remainingMinutes = minutes(raw.timer, "remain");
  const totalMinutes = minutes(raw.timer, "total");
  const errorCode = raw.error ?? null;
  const status = operationalStatus(state, remainingMinutes, errorCode);
  const cycleCount = raw.cycle?.cycleCount ?? null;
  const estimatedFinishAt = status === "RUNNING"
    ? new Date(Date.parse(observedAt) + remainingMinutes * 60_000).toISOString()
    : null;

  return {
    machineId,
    appliance,
    observedAt,
    state,
    operationalStatus: status,
    remainingMinutes,
    totalMinutes,
    estimatedFinishAt,
    remoteControlEnabled: raw.remoteControlEnable?.remoteControlEnabled ?? null,
    cycleCount,
    sessionId: sessionId(machineId, appliance, status, cycleCount, observedAt, previous),
    errorCode,
  };
}

function eventId(current: LaundryApplianceSnapshot, type: string): string {
  return `${current.machineId}:${current.appliance}:${current.sessionId ?? "none"}:${current.observedAt}:${type}`;
}

function event(
  type: LaundryEvent["type"],
  previous: LaundryApplianceSnapshot,
  current: LaundryApplianceSnapshot,
  etaDeltaMinutes: number | null = null,
  detail: Record<string, JsonValue> = {},
): LaundryEvent {
  return {
    id: eventId(current, type),
    machineId: current.machineId,
    appliance: current.appliance,
    sessionId: current.sessionId,
    type,
    previousObservedAt: previous.observedAt,
    observedAt: current.observedAt,
    etaDeltaMinutes,
    previousState: previous.state.raw ?? previous.state.code,
    currentState: current.state.raw ?? current.state.code,
    detail: {
      ...detail,
      changeWindow: {
        after: previous.observedAt,
        atOrBefore: current.observedAt,
      },
    },
  };
}

function detectEvents(previous: LaundryApplianceSnapshot | null, current: LaundryApplianceSnapshot): LaundryEvent[] {
  if (!previous) return current.state.known ? [] : [{
    id: eventId(current, "UNKNOWN_STATE"),
    machineId: current.machineId,
    appliance: current.appliance,
    sessionId: current.sessionId,
    type: "UNKNOWN_STATE",
    previousObservedAt: null,
    observedAt: current.observedAt,
    etaDeltaMinutes: null,
    previousState: null,
    currentState: current.state.raw ?? current.state.code,
    detail: {},
  }];

  const events: LaundryEvent[] = [];
  const wasRunning = previous.operationalStatus === "RUNNING";
  const isRunning = current.operationalStatus === "RUNNING";

  if (!current.state.known && previous.state.raw !== current.state.raw) {
    events.push(event("UNKNOWN_STATE", previous, current));
  }
  if (!wasRunning && isRunning) events.push(event("STARTED", previous, current));
  if (current.operationalStatus === "ERROR" && previous.operationalStatus !== "ERROR") {
    events.push(event("ERROR_ENTERED", previous, current, null, { errorCode: current.errorCode }));
  }
  if (previous.operationalStatus === "ERROR" && current.operationalStatus !== "ERROR") {
    events.push(event("ERROR_CLEARED", previous, current, null, { previousErrorCode: previous.errorCode }));
  }
  if (current.operationalStatus === "PAUSED" && previous.operationalStatus !== "PAUSED") {
    events.push(event("PAUSED", previous, current));
  }
  if (current.operationalStatus === "COMPLETED" && previous.operationalStatus !== "COMPLETED") {
    events.push(event("COMPLETED", previous, current));
  }
  if (wasRunning && current.operationalStatus === "IDLE") {
    events.push(event("STOPPED_UNEXPECTEDLY", previous, current));
  }
  if ((previous.state.raw ?? previous.state.code) !== (current.state.raw ?? current.state.code)) {
    events.push(event("STATE_CHANGED", previous, current));
  }

  if (wasRunning && isRunning && previous.sessionId === current.sessionId) {
    const elapsedMinutes = (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) / 60_000;
    const etaDelta = Math.round((current.remainingMinutes - previous.remainingMinutes + elapsedMinutes) * 10) / 10;
    const etaType = etaDelta > 1 ? "ETA_EXTENDED" : etaDelta < -1 ? "ETA_REDUCED" : "COUNTDOWN_NORMAL";
    events.push(event(etaType, previous, current, etaDelta, {
      elapsedMinutes,
      previousRemainingMinutes: previous.remainingMinutes,
      currentRemainingMinutes: current.remainingMinutes,
    }));
    if (previous.totalMinutes !== current.totalMinutes) {
      events.push(event("TOTAL_TIME_ADJUSTED", previous, current, null, {
        previousTotalMinutes: previous.totalMinutes,
        currentTotalMinutes: current.totalMinutes,
      }));
    }
  }

  return events;
}

export function normalizeLaundry(
  rawValue: unknown,
  sourceVersionSha: string,
  observedAt: string,
  previous: LaundryVersion | null,
  options: NormalizeLaundryOptions = {},
): LaundryVersion {
  const parsed = laundryResponseSchema.parse(rawValue);
  const knownStates = new Set<string>([...LG_RUN_STATE_BASELINE, ...(options.knownRunStates ?? [])]);
  const unknownEnums: UnknownEnumObservation[] = [];
  const events: LaundryEvent[] = [];

  const machines = Object.entries(parsed)
    .sort(([left], [right]) => left.localeCompare(right, "ko"))
    .map(([machineId, tower]) => {
      const previousWasher = previousAppliance(previous, machineId, "washer");
      const previousDryer = previousAppliance(previous, machineId, "dryer");
      const washer = tower.washer
        ? normalizeAppliance(machineId, "washer", tower.washer, observedAt, knownStates, previousWasher, unknownEnums)
        : null;
      const dryer = tower.dryer
        ? normalizeAppliance(machineId, "dryer", tower.dryer, observedAt, knownStates, previousDryer, unknownEnums)
        : null;
      if (washer) events.push(...detectEvents(previousWasher, washer));
      if (dryer) events.push(...detectEvents(previousDryer, dryer));
      return { id: machineId, washer, dryer };
    });

  return {
    schemaVersion: 1,
    sourceVersionSha,
    observedAt,
    machines,
    events,
    unknownEnums,
  };
}
