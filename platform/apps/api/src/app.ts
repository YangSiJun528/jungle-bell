import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import {
  attendanceNotificationEvent as createAttendanceNotificationEvent,
} from "./attendance/reminder-policy.js";
import {
  attendanceRuleSchema,
  laundryQueueInputSchema,
  laundryWatchInputSchema,
  mealRuleSchema,
  type LaundryQueueEntry,
  type LaundryWatch,
  type PublicCampusSnapshot,
} from "./campus/contracts.js";
import {
  CampusUserConflictError,
  type SqliteCampusUserRepository,
} from "./campus/repository.js";
import type { CampusCollectorService } from "./campus/service.js";
import {
  DEFAULT_DEVICE_SESSION_TTL_MS,
  DEVICE_SESSION_SCOPES,
  InMemoryPairingStore,
  PairingDomainError,
  PairingService,
  decodePairingQrPayload,
  normalizeManualPairingCode,
  type DeviceSessionPrincipal,
  type DeviceSessionSummary,
  type PairingStore,
} from "./domain/index.js";
import {
  InMemoryClaimTransportStore,
  InMemoryDesktopSessionStore,
} from "./infra/in-memory-session-transport.js";
import {
  CryptoRandomSource,
  Sha256Hasher,
  SystemClock,
  randomOpaqueToken,
} from "./infra/crypto.js";
import type {
  AttendanceSnapshotRecord,
  AttendanceSnapshotStore,
  ClaimTransportStore,
  DesktopDeviceRecord,
  DesktopIdentityStore,
  DesktopSessionRecord,
  DesktopSessionStore,
  PairingApprovalTransportStore,
} from "./infra/sqlite/index.js";
import {
  ATTENDANCE_COHORT_STATUSES,
  InMemoryAttendanceSnapshotStore,
  InMemoryDesktopIdentityStore,
} from "./infra/sqlite/index.js";
import {
  LmsGatewayError,
  LmsHttpGateway,
} from "./lms/gateway.js";
import { computeLmsIdentitySha256 } from "./lms/identity-hash.js";
import { computeLmsSubjectBinding } from "./lms/subject-binding.js";
import {
  AesGcmSessionSealer,
  LmsSessionError,
  normalizeLmsCookies,
} from "./lms/session-vault.js";
import {
  desktopNotificationAckSchema,
  type NotificationRepository,
  type NotificationSourceEvent,
} from "./notifications/index.js";
import {
  InMemoryPushSubscriptionStore,
  type PushDeliveryCoordinator,
  PushPayloadError,
  parsePushSubscription,
  type PushSubscriptionStore,
} from "./push/index.js";

export interface BuildAppOptions {
  allowDevBootstrap?: boolean;
  attendanceSnapshotStore?: AttendanceSnapshotStore;
  campusCollector?: Pick<
    CampusCollectorService,
    "getLatest" | "getMealHistory"
  >;
  campusUserRepository?: Pick<
    SqliteCampusUserRepository,
    | "createWatch"
    | "enqueue"
    | "getAttendanceRule"
    | "getMealRule"
    | "leaveQueue"
    | "listQueueByUser"
    | "listWatchesByUser"
    | "setWatchStatus"
    | "upsertAttendanceRule"
    | "upsertMealRule"
  >;
  claimTransportStore?: ClaimTransportStore;
  desktopIdentityStore?: DesktopIdentityStore;
  desktopSessionStore?: DesktopSessionStore;
  lmsGateway?: Pick<LmsHttpGateway, "verifyIdentity">;
  logger?: boolean;
  notificationEventSink?: {
    record(event: NotificationSourceEvent): unknown;
  };
  notificationRepository?: Pick<
    NotificationRepository,
    | "acknowledgeDesktop"
    | "cancelDeviceDeliveries"
    | "claimDesktopInbox"
  >;
  pairingApprovalTransportStore?: PairingApprovalTransportStore;
  pairingStore?: PairingStore;
  publicOrigin?: string;
  pushSubscriptionStore?: PushSubscriptionStore;
  pushDeliveryCoordinator?: Pick<PushDeliveryCoordinator, "deliver">;
  readinessCheck?: () => boolean | Promise<boolean>;
  tokenSealer?: AesGcmSessionSealer;
  trustProxy?: boolean | number | string;
  vapidPublicKey?: string;
  webRoot?: string;
}

const pairingParamsSchema = z
  .object({
    pairingId: z.string().regex(/^jbc_[0-9a-f]{32}$/),
  })
  .strict();

const mobileSessionParamsSchema = z
  .object({
    sessionId: z.string().regex(/^jbsi_[0-9a-f]{32}$/),
  })
  .strict();

const claimBodySchema = z
  .object({
    challenge: z.string().regex(/^jbp_[0-9a-f]{64}$/),
    deviceLabel: z.string().trim().min(1).max(80),
    installationId: z.string().regex(/^jbmi_[0-9a-f]{32}$/),
  })
  .strict();

const manualClaimBodySchema = z
  .object({
    manualCode: z.string().trim().min(10).max(32),
    deviceLabel: z.string().trim().min(1).max(80),
    installationId: z.string().regex(/^jbmi_[0-9a-f]{32}$/),
  })
  .strict();

const claimReferenceSchema = z
  .object({
    claimId: z.string().regex(/^jbc_[0-9a-f]{32}$/),
  })
  .strict();

const completeBodySchema = claimReferenceSchema
  .extend({
    claimReceipt: z.string().regex(/^jbcr_[0-9a-f]{64}$/),
  })
  .strict();

const desktopDeviceIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u);

const lmsIdentityBodySchema = z
  .object({
    desktopDeviceId: desktopDeviceIdSchema,
    subjectBinding: z.string().regex(/^[0-9a-f]{64}$/u),
    cookies: z.array(z.unknown()).length(1),
  })
  .strict();

const heartbeatBodySchema = z
  .object({
    lmsSessionState: z.enum([
      "unknown",
      "connected",
      "login-required",
    ]),
    appVersion: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict();

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(isValidIsoDate);

const attendanceSnapshotBodySchema = z
  .object({
    attendanceDate: isoDateSchema,
    cohortId: z.string().trim().min(1).max(128).nullable(),
    cohortStatus: z.enum(ATTENDANCE_COHORT_STATUSES),
    cohortStartDate: isoDateSchema.nullable(),
    cohortEndDate: isoDateSchema.nullable(),
    morningChecked: z.boolean(),
    eveningChecked: z.boolean(),
    collectedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (value) =>
      value.cohortStartDate === null ||
      value.cohortEndDate === null ||
      value.cohortStartDate <= value.cohortEndDate,
    { message: "Invalid cohort date range." },
  );

const pushSubscriptionParamsSchema = z
  .object({
    subscriptionId: z.string().regex(/^jbps_[0-9a-f]{64}$/),
  })
  .strict();

const resourceParamsSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  })
  .strict();

const notificationParamsSchema = z
  .object({
    deliveryId: z.string().uuid(),
  })
  .strict();

const notificationInboxQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(20).default(20),
  })
  .strict();

const mealHistoryQuerySchema = z
  .object({
    before: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const APP_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEV_APP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DESKTOP_ONLINE_WINDOW_MS = 5 * 60 * 1000;
const ATTENDANCE_FRESH_WINDOW_MS = 15 * 60 * 1000;
const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DESKTOP_NOTIFICATION_ACK_LEASE_MS = 2 * 60 * 1000;
const DESKTOP_NOTIFICATION_RETRY_MS = 5_000;
const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const WEB_CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; media-src 'none'; worker-src 'self'; manifest-src 'self'";

interface AppSessionCookieConfig {
  readonly domain: string;
  readonly name: "__Secure-jb_app" | "jb_app";
  readonly secure: boolean;
}

interface DeviceSessionCookieConfig {
  readonly name: "__Host-jb_device" | "jb_device";
  readonly secure: boolean;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const publicOrigin = normalizePublicOrigin(
    options.publicOrigin ?? "http://127.0.0.1:5173",
  );
  const publicUrl = new URL(publicOrigin);
  const secureCookies = publicUrl.protocol === "https:";
  const loopbackHttp =
    publicUrl.protocol === "http:" &&
    isLoopbackHostname(publicUrl.hostname);
  const appSessionCookie: AppSessionCookieConfig = {
    domain: cookieDomain(publicUrl),
    name: loopbackHttp ? "jb_app" : "__Secure-jb_app",
    secure: !loopbackHttp,
  };
  const deviceSessionCookie: DeviceSessionCookieConfig = {
    name: loopbackHttp ? "jb_device" : "__Host-jb_device",
    secure: !loopbackHttp,
  };
  const app = Fastify({
    logger: options.logger
      ? {
          level: "info",
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers[\"set-cookie\"]",
          ],
        }
      : false,
    bodyLimit: 32 * 1024,
    trustProxy: options.trustProxy ?? false,
  });
  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    methods: ["DELETE", "GET", "POST", "PUT"],
    origin: [publicOrigin],
  });
  await app.register(rateLimit, {
    global: false,
    max: 20,
    timeWindow: "1 minute",
  });
  app.addHook("onRequest", async (request, reply) => {
    if (isSafeMethod(request.method)) {
      return;
    }
    if (request.headers.origin === publicOrigin) {
      return;
    }
    if (
      request.headers.origin === undefined &&
      permitsMissingNativeOrigin(request)
    ) {
      return;
    }
    return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "permissions-policy",
      "camera=(), geolocation=(), microphone=()",
    );
    if (isApiUrl(request.url)) {
      reply.header(
        "content-security-policy",
        API_CONTENT_SECURITY_POLICY,
      );
      reply.header("cache-control", "no-store");
    } else if (isHtmlContentType(reply.getHeader("content-type"))) {
      reply.header(
        "content-security-policy",
        WEB_CONTENT_SECURITY_POLICY,
      );
      reply.header("cache-control", "no-store");
    }
    if (secureCookies) {
      reply.header(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    }
    return payload;
  });

  const clock = new SystemClock();
  const random = new CryptoRandomSource();
  const hasher = new Sha256Hasher();
  const pairingStore = options.pairingStore ?? new InMemoryPairingStore();
  const pairingService = new PairingService({
    clock,
    random,
    hasher,
    store: pairingStore,
    challengeTtlMs: 2 * 60 * 1000,
    deviceSessionTtlMs: DEFAULT_DEVICE_SESSION_TTL_MS,
  });
  const desktopSessions =
    options.desktopSessionStore ?? new InMemoryDesktopSessionStore();
  const desktopIdentities =
    options.desktopIdentityStore ?? new InMemoryDesktopIdentityStore();
  const attendanceSnapshots =
    options.attendanceSnapshotStore ??
    new InMemoryAttendanceSnapshotStore();
  const claimTransports =
    options.claimTransportStore ?? new InMemoryClaimTransportStore();
  const tokenSealer =
    options.tokenSealer ?? new AesGcmSessionSealer(randomBytes(32));
  const lmsGateway = options.lmsGateway ?? new LmsHttpGateway();
  const pushSubscriptions =
    options.pushSubscriptionStore ?? new InMemoryPushSubscriptionStore();
  const manualPairingAttempts = new ManualPairingAttemptLimiter();
  const ipRateLimitKey = (request: FastifyRequest): string =>
    `ip:${request.ip}`;
  const desktopRateLimitKey = async (
    request: FastifyRequest,
  ): Promise<string> => {
    const desktop = await findValidAppSession(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
    );
    return desktop === null
      ? ipRateLimitKey(request)
      : `desktop:${desktop.tokenHash}`;
  };
  const mobileRateLimitKey = async (
    request: FastifyRequest,
  ): Promise<string> => {
    try {
      const mobile = await pairingService.authenticateDeviceSession(
        request.cookies[deviceSessionCookie.name] ?? "",
      );
      return `mobile:${mobile.sessionId}`;
    } catch (error) {
      if (error instanceof PairingDomainError) {
        return ipRateLimitKey(request);
      }
      throw error;
    }
  };
  const privateRateLimitKey = async (
    request: FastifyRequest,
  ): Promise<string> => {
    const desktop = await findValidAppSession(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
    );
    return desktop === null
      ? mobileRateLimitKey(request)
      : `desktop:${desktop.tokenHash}`;
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    if (error instanceof PairingDomainError) {
      return sendPairingError(reply, error);
    }
    if (error instanceof LmsSessionError) {
      const invalidInput = new Set([
        "LMS_COOKIE_INVALID",
        "LMS_COOKIE_SCOPE_INVALID",
        "LMS_ACCESS_COOKIE_REQUIRED",
        "LMS_USER_ID_INVALID",
      ]);
      return reply
        .code(invalidInput.has(error.code) ? 400 : 500)
        .send({ error: invalidInput.has(error.code) ? error.code : "INTERNAL_ERROR" });
    }
    if (error instanceof LmsGatewayError) {
      const statusCode =
        error.failureKind === "invalid-input"
          ? 400
          : error.failureKind === "transient"
            ? 503
            : 502;
      return reply
        .code(statusCode)
        .send({
          error:
            error.failureKind === "invalid-input"
              ? error.code
              : "LMS_UPSTREAM_UNAVAILABLE",
        });
    }
    if (error instanceof PushPayloadError) {
      return reply.code(400).send({ error: error.code });
    }
    const clientStatus = readClientErrorStatus(error);
    if (clientStatus !== null) {
      return reply.code(clientStatus).send({
        error:
          clientStatus === 429 ? "RATE_LIMITED" : "INVALID_REQUEST",
      });
    }
    request.log.error({ err: error }, "unhandled API error");
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/ready", async (request, reply) => {
    try {
      const ready =
        options.readinessCheck === undefined ||
        (await options.readinessCheck());
      if (ready) {
        return { status: "ready" };
      }
    } catch {
      request.log.warn("readiness check failed");
    }
    return reply.code(503).send({ status: "unavailable" });
  });

  app.get("/api/public/campus/laundry", async () =>
    readPublicCampusSnapshot("laundry", options.campusCollector),
  );

  app.get("/api/public/campus/meals", async () =>
    readPublicCampusSnapshot("meals", options.campusCollector),
  );

  app.get(
    "/api/public/campus/meals/history",
    async (request, reply) => {
      if (options.campusCollector === undefined) {
        return reply
          .code(503)
          .send({ error: "CAMPUS_COLLECTOR_NOT_CONFIGURED" });
      }
      const query = mealHistoryQuerySchema.parse(request.query);
      return options.campusCollector.getMealHistory({
        ...(query.before === undefined
          ? {}
          : { before: query.before }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
    },
  );

  app.post(
    "/api/onboarding/lms-identity",
    { config: { rateLimit: { max: 600, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const priorAppSession = await findValidAppSession(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
      );
      const body = lmsIdentityBodySchema.parse(request.body);
      const accessCookies = normalizeLmsCookies(body.cookies);
      if (
        accessCookies.length !== 1 ||
        accessCookies[0]?.name !== "access_token"
      ) {
        throw new LmsSessionError("LMS_ACCESS_COOKIE_REQUIRED");
      }
      const verified = await lmsGateway.verifyIdentity(accessCookies);
      if (!verified.authenticated) {
        return reply.code(401).send({ error: "LMS_SESSION_REJECTED" });
      }
      if (verified.subject === null) {
        return reply.code(502).send({ error: "LMS_IDENTITY_UNAVAILABLE" });
      }
      const expectedSubjectBinding = computeLmsSubjectBinding(
        body.desktopDeviceId,
        verified.subject,
      );
      if (!safeHashEquals(expectedSubjectBinding, body.subjectBinding)) {
        return reply
          .code(401)
          .send({ error: "LMS_SUBJECT_BINDING_MISMATCH" });
      }

      const now = clock.now();
      const identity = await desktopIdentities.registerVerifiedIdentity({
        candidateUserId: randomUUID(),
        desktopDeviceId: body.desktopDeviceId,
        subjectSha256: computeLmsIdentitySha256(verified.subject),
        verifiedAtEpochMs: now,
      });
      const appSessionToken = await issueAppSession({
        desktopDeviceId: identity.desktopDeviceId,
        expiresAtEpochMs: now + APP_SESSION_TTL_MS,
        hasher,
        now,
        sessions: desktopSessions,
        userId: identity.userId,
      });
      if (
        priorAppSession !== null &&
        (priorAppSession.userId !== identity.userId ||
          priorAppSession.desktopDeviceId !== identity.desktopDeviceId)
      ) {
        const priorDevice = await desktopIdentities.getDesktopDevice(
          priorAppSession.userId,
          priorAppSession.desktopDeviceId,
        );
        await desktopIdentities.recordHeartbeat({
          userId: priorAppSession.userId,
          desktopDeviceId: priorAppSession.desktopDeviceId,
          receivedAtEpochMs: now,
          lmsSessionState: "login-required",
          appVersion: priorDevice?.appVersion ?? null,
        });
        await desktopSessions.revoke({
          tokenHash: priorAppSession.tokenHash,
          revokedAtEpochMs: now,
          expectedVersion: priorAppSession.version,
        });
      }
      setAppSessionCookie(
        reply,
        appSessionCookie,
        appSessionToken,
        APP_SESSION_TTL_MS,
      );
      reply.header("cache-control", "no-store");
      return reply.code(204).send();
    },
  );

  if (options.allowDevBootstrap === true) {
    app.post("/api/dev/desktop-session", async (_request, reply) => {
      const now = clock.now();
      const identity = await desktopIdentities.registerVerifiedIdentity({
        candidateUserId: "demo-user",
        desktopDeviceId: "demo-desktop",
        subjectSha256: computeLmsIdentitySha256(
          "development-demo-user",
        ),
        verifiedAtEpochMs: now,
      });
      const appSessionToken = await issueAppSession({
        desktopDeviceId: identity.desktopDeviceId,
        expiresAtEpochMs: now + DEV_APP_SESSION_TTL_MS,
        hasher,
        now,
        sessions: desktopSessions,
        userId: identity.userId,
      });
      setAppSessionCookie(
        reply,
        appSessionCookie,
        appSessionToken,
        DEV_APP_SESSION_TTL_MS,
      );
      reply.header("cache-control", "no-store");
      return reply.code(204).send();
    });
  }

  app.post(
    "/api/pairings",
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: desktopRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const desktop = await authenticateDesktop(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
      );
      const created = await pairingService.createChallenge({
        userId: desktop.userId,
        desktopDeviceId: desktop.desktopDeviceId,
      });
      const decoded = decodePairingQrPayload(created.qrPayload);
      const fragment = new URLSearchParams({
        pairing: created.challengeId,
        challenge: decoded.pairingCode,
      });
      return reply.code(201).send({
        pairingId: created.challengeId,
        qrPayload: `${publicOrigin}/pair#${fragment.toString()}`,
        manualCode: created.manualCode,
        expiresAt: new Date(created.expiresAtEpochMs).toISOString(),
      });
    },
  );

  app.post(
    "/api/pairings/:pairingId/claims",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { pairingId } = pairingParamsSchema.parse(request.params);
      const body = claimBodySchema.parse(request.body);
      const challengeRecord =
        await pairingStore.findChallengeByPairingCodeHash(
          await hasher.hash(body.challenge),
        );
      if (challengeRecord?.challengeId !== pairingId) {
        throw new PairingDomainError(
          "PAIRING_NOT_FOUND",
          "Pairing proof is invalid.",
        );
      }

      await pairingService.claimPairing({
        pairingCode: body.challenge,
        deviceLabel: body.deviceLabel,
        installationId: body.installationId,
      });

      const claimReceipt = randomOpaqueToken("jbcr_");
      const now = clock.now();
      const inserted = await claimTransports.insert({
        claimId: pairingId,
        challengeId: pairingId,
        receiptHash: await hasher.hash(claimReceipt),
        approvedSessionCiphertext: null,
        createdAtEpochMs: now,
        expiresAtEpochMs: challengeRecord.expiresAtEpochMs,
        deliveredAtEpochMs: null,
        version: 0,
      });
      if (!inserted) {
        throw new PairingDomainError(
          "PAIRING_ALREADY_USED",
          "Pairing claim transport already exists.",
        );
      }
      return reply.code(201).send({
        claimId: pairingId,
        claimReceipt,
        status: "awaiting-desktop-approval",
      });
    },
  );

  app.post(
    "/api/pairing-claims",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = manualClaimBodySchema.parse(request.body);
      const manualCode = normalizeManualPairingCode(body.manualCode);
      if (!manualPairingAttempts.consume(manualCode, clock.now())) {
        return reply.code(429).send({
          error: "PAIRING_MANUAL_CODE_LOCKED",
        });
      }
      const challengeRecord =
        await pairingStore.findChallengeByManualCodeHash(
          await hasher.hash(manualCode),
        );
      if (challengeRecord === null) {
        throw new PairingDomainError(
          "PAIRING_NOT_FOUND",
          "Manual pairing code is invalid.",
        );
      }

      await pairingService.claimPairing({
        manualCode,
        deviceLabel: body.deviceLabel,
        installationId: body.installationId,
      });

      const claimReceipt = randomOpaqueToken("jbcr_");
      const now = clock.now();
      const inserted = await claimTransports.insert({
        claimId: challengeRecord.challengeId,
        challengeId: challengeRecord.challengeId,
        receiptHash: await hasher.hash(claimReceipt),
        approvedSessionCiphertext: null,
        createdAtEpochMs: now,
        expiresAtEpochMs: challengeRecord.expiresAtEpochMs,
        deliveredAtEpochMs: null,
        version: 0,
      });
      if (!inserted) {
        throw new PairingDomainError(
          "PAIRING_ALREADY_USED",
          "Pairing claim transport already exists.",
        );
      }
      return reply.code(201).send({
        claimId: challengeRecord.challengeId,
        claimReceipt,
        status: "awaiting-desktop-approval",
      });
    },
  );

  app.get("/api/pairings/:pairingId", async (request) => {
    const desktop = await authenticateDesktop(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
    );
    const { pairingId } = pairingParamsSchema.parse(request.params);
    try {
      const claim = await pairingService.getPendingClaim({
        challengeId: pairingId,
        desktopDeviceId: desktop.desktopDeviceId,
      });
      return {
        status: "claimed",
        claim: {
          claimId: pairingId,
          deviceLabel: claim.deviceLabel,
          confirmationCode: claim.installationId
            .slice(-4)
            .toUpperCase(),
        },
      };
    } catch (error) {
      if (
        error instanceof PairingDomainError &&
        error.code === "PAIRING_NOT_CLAIMED"
      ) {
        return { status: "pending", claim: null };
      }
      if (
        error instanceof PairingDomainError &&
        error.code === "PAIRING_ALREADY_USED"
      ) {
        const transport = await claimTransports.get(pairingId);
        return {
          status:
            transport !== null && transport.deliveredAtEpochMs !== null
              ? "completed"
              : "approved",
          claim: null,
        };
      }
      throw error;
    }
  });

  app.post("/api/pairings/:pairingId/approve", async (request, reply) => {
    const desktop = await authenticateDesktop(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
    );
    const { pairingId } = pairingParamsSchema.parse(request.params);
    const { claimId } = claimReferenceSchema.parse(request.body);
    const transport = await claimTransports.get(pairingId);
    if (claimId !== pairingId || transport?.claimId !== claimId) {
      throw new PairingDomainError(
        "PAIRING_NOT_FOUND",
        "Pairing claim was not found.",
      );
    }

    await pairingService.approvePairing(
      {
        challengeId: pairingId,
        desktopDeviceId: desktop.desktopDeviceId,
        scopes: DEVICE_SESSION_SCOPES,
      },
      async (proposal) => {
        const ciphertext = JSON.stringify(
          tokenSealer.seal(proposal.sessionToken, pairingId),
        );
        if (options.pairingApprovalTransportStore !== undefined) {
          return options.pairingApprovalTransportStore
            .commitApprovalWithTransport({
              challenge: proposal.challenge,
              expectedChallengeVersion:
                proposal.expectedChallengeVersion,
              session: proposal.session,
              claimId: pairingId,
              approvedSessionCiphertext: ciphertext,
              expectedTransportVersion: transport.version,
            });
        }
        const sessionStored = await pairingStore.commitApproval(
          proposal.challenge,
          proposal.expectedChallengeVersion,
          proposal.session,
        );
        if (!sessionStored) {
          return false;
        }
        const transportStored =
          await claimTransports.setApprovedCiphertext({
            claimId: pairingId,
            approvedSessionCiphertext: ciphertext,
            expectedVersion: transport.version,
          });
        if (!transportStored) {
          throw new Error("PAIRING_TRANSPORT_COMMIT_FAILED");
        }
        return true;
      },
    );
    return reply.code(204).send();
  });

  app.post("/api/pairings/:pairingId/complete", async (request, reply) => {
    const { pairingId } = pairingParamsSchema.parse(request.params);
    const body = completeBodySchema.parse(request.body);
    const transport = await claimTransports.get(pairingId);
    const receiptHash = await hasher.hash(body.claimReceipt);

    if (
      body.claimId !== pairingId ||
      transport === null ||
      !safeHashEquals(transport.receiptHash, receiptHash)
    ) {
      return reply.code(401).send({ error: "PAIRING_RECEIPT_INVALID" });
    }
    if (transport.approvedSessionCiphertext === null) {
      return reply.code(409).send({ error: "PAIRING_NOT_APPROVED" });
    }

    const approvedSessionCiphertext =
      await claimTransports.getApprovedCiphertextForDelivery({
        claimId: pairingId,
        receiptHash,
        deliveredAtEpochMs: clock.now(),
      });
    if (approvedSessionCiphertext === null) {
      return reply.code(409).send({ error: "PAIRING_EXPIRED" });
    }
    const token = tokenSealer.open(
      JSON.parse(approvedSessionCiphertext) as Parameters<
        AesGcmSessionSealer["open"]
      >[0],
      pairingId,
    );
    const previousDeviceToken =
      request.cookies[deviceSessionCookie.name];
    if (
      previousDeviceToken !== undefined &&
      previousDeviceToken !== token
    ) {
      const revoked =
        await pairingService.revokeDeviceSessionTokenIfPresent(
          previousDeviceToken,
        );
      if (revoked !== null) {
        await revokePushSubscriptionsForDevice(
          pushSubscriptions,
          revoked.userId,
          revoked.deviceId,
          clock.now(),
        );
        options.notificationRepository?.cancelDeviceDeliveries(
          revoked.userId,
          revoked.deviceId,
          "web-push",
          clock.now(),
          "DEVICE_REVOKED",
        );
      }
    }
    const principal = await pairingService.authenticateDeviceSession(token);
    setDeviceSessionCookie(
      reply,
      deviceSessionCookie,
      token,
      principal.expiresAtEpochMs,
      clock.now(),
    );
    return reply.code(204).send();
  });

  app.get(
    "/api/private/desktop/mobile-sessions",
    async (request) => {
      const desktop = await authenticateDesktop(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
      );
      const nowEpochMs = clock.now();
      const sessions = await pairingService.listDeviceSessions(
        desktop.userId,
      );
      const pushEnabledDeviceIds = new Set(
        (
          await pushSubscriptions.listActiveByUserId(desktop.userId)
        ).map((subscription) => subscription.deviceId),
      );
      return {
        sessions: [...sessions]
          .sort(
            (left, right) =>
              right.createdAtEpochMs - left.createdAtEpochMs ||
              left.sessionId.localeCompare(right.sessionId),
          )
          .map((session) =>
            toApiMobileSession(
              session,
              nowEpochMs,
              pushEnabledDeviceIds.has(session.deviceId),
            ),
          ),
      };
    },
  );

  app.delete(
    "/api/private/desktop/mobile-sessions/:sessionId",
    async (request, reply) => {
      const desktop = await authenticateDesktop(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
      );
      const { sessionId } = mobileSessionParamsSchema.parse(
        request.params,
      );
      const revoked = await pairingService.revokeDeviceSession({
        userId: desktop.userId,
        sessionId,
      });
      await revokePushSubscriptionsForDevice(
        pushSubscriptions,
        revoked.userId,
        revoked.deviceId,
        clock.now(),
      );
      options.notificationRepository?.cancelDeviceDeliveries(
        revoked.userId,
        revoked.deviceId,
        "web-push",
        clock.now(),
        "DEVICE_REVOKED",
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    "/api/private/mobile/session",
    async (request, reply) => {
      const mobile = await authenticateMobile(
        request,
        pairingService,
        "attendance:read",
        deviceSessionCookie.name,
      );
      const revoked = await pairingService.revokeDeviceSession({
        userId: mobile.userId,
        sessionId: mobile.sessionId,
      });
      await revokePushSubscriptionsForDevice(
        pushSubscriptions,
        revoked.userId,
        revoked.deviceId,
        clock.now(),
      );
      options.notificationRepository?.cancelDeviceDeliveries(
        revoked.userId,
        revoked.deviceId,
        "web-push",
        clock.now(),
        "DEVICE_REVOKED",
      );
      clearDeviceSessionCookie(reply, deviceSessionCookie);
      return reply.code(204).send();
    },
  );

  app.get("/api/private/dashboard", async (request) => {
    const principal = await authenticateMobile(
      request,
      pairingService,
      "attendance:read",
      deviceSessionCookie.name,
    );
    return {
      device: {
        id: principal.deviceId,
        label: principal.deviceLabel,
      },
      devices: await readDeviceDashboard(
        principal.userId,
        desktopIdentities,
        clock.now(),
      ),
      attendance: await readAttendanceDashboard(
        principal.userId,
        attendanceSnapshots,
        clock.now(),
      ),
    };
  });

  app.get("/api/private/desktop/dashboard", async (request) => {
    const desktop = await authenticateDesktop(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
    );
    return {
      desktop: {
        id: desktop.desktopDeviceId,
      },
      devices: await readDeviceDashboard(
        desktop.userId,
        desktopIdentities,
        clock.now(),
      ),
      attendance: await readAttendanceDashboard(
        desktop.userId,
        attendanceSnapshots,
        clock.now(),
      ),
    };
  });

  app.get("/api/private/desktop/status", async (request) => {
    const desktop = await authenticateDesktop(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
    );
    const device = await desktopIdentities.getDesktopDevice(
      desktop.userId,
      desktop.desktopDeviceId,
    );
    if (device === null) {
      throw new PairingDomainError(
        "DEVICE_SESSION_INVALID",
        "Desktop registration is missing.",
      );
    }
    return {
      authenticated: true,
      user: { id: desktop.userId },
      desktop: toApiDesktopDevice(device, clock.now()),
    };
  });

  app.post(
    "/api/private/desktop/heartbeat",
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: desktopRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const desktop = await authenticateDesktop(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
      );
      const body = heartbeatBodySchema.parse(request.body);
      const receivedAtEpochMs = clock.now();
      const notificationEventSink = options.notificationEventSink;
      let updated: DesktopDeviceRecord | null;
      try {
        updated = await desktopIdentities.recordHeartbeat(
          {
            userId: desktop.userId,
            desktopDeviceId: desktop.desktopDeviceId,
            receivedAtEpochMs,
            lmsSessionState: body.lmsSessionState,
            appVersion: body.appVersion ?? null,
          },
          body.lmsSessionState === "login-required"
            ? () => {
                if (notificationEventSink === undefined) {
                  throw new Error(
                    "Notification event storage is unavailable.",
                  );
                }
                recordDurableNotificationEvent(
                  notificationEventSink,
                  {
                    kind: "login-required",
                    sourceEventId:
                      `login-required:${desktop.desktopDeviceId}:` +
                      `${receivedAtEpochMs}`,
                    userId: desktop.userId,
                    desktopDeviceId: desktop.desktopDeviceId,
                    reason: "expired",
                    occurredAtEpochMs: receivedAtEpochMs,
                  },
                );
              }
            : undefined,
        );
      } catch (error) {
        app.log.warn(
          { err: error, kind: "login-required" },
          "desktop heartbeat durable transition failed",
        );
        return reply
          .code(503)
          .send({ error: "HEARTBEAT_PERSISTENCE_UNAVAILABLE" });
      }
      if (updated === null) {
        return reply.code(409).send({ error: "DESKTOP_NOT_REGISTERED" });
      }
      return reply.send({
        receivedAt: new Date(receivedAtEpochMs).toISOString(),
      });
    },
  );

  app.post(
    "/api/private/desktop/attendance-snapshot",
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: desktopRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const desktop = await authenticateDesktop(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
      );
      const body = attendanceSnapshotBodySchema.parse(request.body);
      const receivedAtEpochMs = clock.now();
      const collectedAtEpochMs = Date.parse(body.collectedAt);
      if (
        !Number.isSafeInteger(collectedAtEpochMs) ||
        collectedAtEpochMs > receivedAtEpochMs + MAX_CLIENT_CLOCK_SKEW_MS
      ) {
        return reply
          .code(400)
          .send({ error: "ATTENDANCE_COLLECTION_TIME_INVALID" });
      }
      const device = await desktopIdentities.recordHeartbeat({
        userId: desktop.userId,
        desktopDeviceId: desktop.desktopDeviceId,
        receivedAtEpochMs,
        lmsSessionState: "connected",
        appVersion:
          (
            await desktopIdentities.getDesktopDevice(
              desktop.userId,
              desktop.desktopDeviceId,
            )
          )?.appVersion ?? null,
      });
      if (device === null) {
        return reply.code(409).send({ error: "DESKTOP_NOT_REGISTERED" });
      }
      const previousSnapshot = await attendanceSnapshots.getLatest(
        desktop.userId,
      );
      const result = await attendanceSnapshots.putNewest({
        userId: desktop.userId,
        sourceDeviceId: desktop.desktopDeviceId,
        attendanceDate: body.attendanceDate,
        cohortId: body.cohortId,
        cohortStatus: body.cohortStatus,
        cohortStartDate: body.cohortStartDate,
        cohortEndDate: body.cohortEndDate,
        morningChecked: body.morningChecked,
        eveningChecked: body.eveningChecked,
        collectedAtEpochMs,
        receivedAtEpochMs,
      });
      if (result.accepted) {
        const notificationSnapshots = [result.snapshot];
        if (
          previousSnapshot !== null &&
          previousSnapshot.attendanceDate !==
            result.snapshot.attendanceDate
        ) {
          notificationSnapshots.push(previousSnapshot);
        }
        const recordedEventIds = new Set<string>();
        for (const snapshot of notificationSnapshots) {
          const event = attendanceNotificationEvent(
            snapshot,
            receivedAtEpochMs,
          );
          if (
            event !== null &&
            !recordedEventIds.has(event.sourceEventId)
          ) {
            recordedEventIds.add(event.sourceEventId);
            recordBestEffortNotificationEvent(
              options.notificationEventSink,
              event,
              app,
            );
          }
        }
      }
      return reply.send({
        accepted: result.accepted,
        attendance: await readAttendanceDashboard(
          desktop.userId,
          attendanceSnapshots,
          clock.now(),
        ),
      });
    },
  );

  app.delete("/api/private/desktop/session", async (request, reply) => {
    const desktop = await authenticateDesktop(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
    );
    clearAppSessionCookie(reply, appSessionCookie);
    const currentDevice = await desktopIdentities.getDesktopDevice(
      desktop.userId,
      desktop.desktopDeviceId,
    );
    await desktopIdentities.recordHeartbeat({
      userId: desktop.userId,
      desktopDeviceId: desktop.desktopDeviceId,
      receivedAtEpochMs: clock.now(),
      lmsSessionState: "login-required",
      appVersion: currentDevice?.appVersion ?? null,
    });
    options.notificationRepository?.cancelDeviceDeliveries(
      desktop.userId,
      desktop.desktopDeviceId,
      "desktop",
      clock.now(),
      "DESKTOP_UNLINKED",
    );
    await desktopSessions.revoke({
      tokenHash: desktop.tokenHash,
      revokedAtEpochMs: clock.now(),
      expectedVersion: desktop.version,
    });
    return reply.code(204).send();
  });

  app.get("/api/private/desktop/notifications", async (request, reply) => {
    const desktop = await authenticateDesktop(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
    );
    const repository = options.notificationRepository;
    if (repository === undefined) {
      return reply
        .code(503)
        .send({ error: "NOTIFICATION_SERVICE_UNAVAILABLE" });
    }
    const currentDevice = await desktopIdentities.getDesktopDevice(
      desktop.userId,
      desktop.desktopDeviceId,
    );
    if (currentDevice === null) {
      return reply
        .code(409)
        .send({ error: "DESKTOP_NOT_REGISTERED" });
    }
    const receivedAtEpochMs = clock.now();
    const updated = await desktopIdentities.recordHeartbeat({
      userId: desktop.userId,
      desktopDeviceId: desktop.desktopDeviceId,
      receivedAtEpochMs,
      lmsSessionState: currentDevice.lmsSessionState,
      appVersion: currentDevice.appVersion,
    });
    if (updated === null) {
      return reply
        .code(409)
        .send({ error: "DESKTOP_NOT_REGISTERED" });
    }
    const { limit } = notificationInboxQuerySchema.parse(request.query);
    return {
      notifications: repository.claimDesktopInbox(
        desktop.userId,
        desktop.desktopDeviceId,
        receivedAtEpochMs,
        limit,
        DESKTOP_NOTIFICATION_ACK_LEASE_MS,
      ),
    };
  });

  app.post(
    "/api/private/desktop/notifications/:deliveryId/ack",
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: desktopRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const desktop = await authenticateDesktop(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
      );
      const repository = options.notificationRepository;
      if (repository === undefined) {
        return reply
          .code(503)
          .send({ error: "NOTIFICATION_SERVICE_UNAVAILABLE" });
      }
      const { deliveryId } = notificationParamsSchema.parse(
        request.params,
      );
      const body = desktopNotificationAckSchema.parse(request.body);
      const nowEpochMs = clock.now();
      if (
        Math.abs(body.occurredAtEpochMs - nowEpochMs) >
        MAX_CLIENT_CLOCK_SKEW_MS
      ) {
        return reply
          .code(400)
          .send({ error: "NOTIFICATION_ACK_TIME_INVALID" });
      }
      const acknowledged = repository.acknowledgeDesktop(
        desktop.userId,
        desktop.desktopDeviceId,
        deliveryId,
        {
          outcome: body.outcome,
          occurredAtEpochMs: nowEpochMs,
        },
        nowEpochMs + DESKTOP_NOTIFICATION_RETRY_MS,
      );
      if (!acknowledged) {
        return reply
          .code(409)
          .send({ error: "NOTIFICATION_ACK_REJECTED" });
      }
      return reply.code(204).send();
    },
  );

  app.get("/api/private/meal-rule", async (request, reply) => {
    const principal = await authenticatePrivateUser(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
      pairingService,
      "preferences:read",
      deviceSessionCookie.name,
    );
    const repository = options.campusUserRepository;
    if (repository === undefined) {
      return reply
        .code(503)
        .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
    }
    const rule = repository.getMealRule(principal.userId);
    return rule === null
      ? {
          enabled: false,
          breakfast: false,
          lunch: false,
          dinner: false,
          updatedAtEpochMs: 0,
        }
      : toApiMealRule(rule);
  });

  app.put(
    "/api/private/meal-rule",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: privateRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePrivateUser(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
        pairingService,
        "preferences:write",
        deviceSessionCookie.name,
      );
      const repository = options.campusUserRepository;
      if (repository === undefined) {
        return reply
          .code(503)
          .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
      }
      const body = mealRuleSchema.parse(request.body);
      const rule = {
        userId: principal.userId,
        ...body,
        updatedAtEpochMs: clock.now(),
      };
      repository.upsertMealRule(rule);
      return reply.send(toApiMealRule(rule));
    },
  );

  app.get("/api/private/attendance-rule", async (request, reply) => {
    const principal = await authenticatePrivateUser(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
      pairingService,
      "preferences:read",
      deviceSessionCookie.name,
    );
    const repository = options.campusUserRepository;
    if (repository === undefined) {
      return reply
        .code(503)
        .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
    }
    const rule = repository.getAttendanceRule(principal.userId);
    return rule === null
      ? {
          enabled: false,
          morning: false,
          evening: false,
          updatedAtEpochMs: 0,
        }
      : toApiAttendanceRule(rule);
  });

  app.put(
    "/api/private/attendance-rule",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: privateRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePrivateUser(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
        pairingService,
        "preferences:write",
        deviceSessionCookie.name,
      );
      const repository = options.campusUserRepository;
      if (repository === undefined) {
        return reply
          .code(503)
          .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
      }
      const body = attendanceRuleSchema.parse(request.body);
      const rule = {
        userId: principal.userId,
        ...body,
        updatedAtEpochMs: clock.now(),
      };
      repository.upsertAttendanceRule(rule);
      return reply.send(toApiAttendanceRule(rule));
    },
  );

  app.get("/api/private/laundry-watches", async (request, reply) => {
    const principal = await authenticatePrivateUser(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
      pairingService,
      "preferences:read",
      deviceSessionCookie.name,
    );
    const repository = options.campusUserRepository;
    if (repository === undefined) {
      return reply
        .code(503)
        .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
    }
    return {
      watches: repository
        .listWatchesByUser(principal.userId)
        .map(toApiLaundryWatch),
    };
  });

  app.post(
    "/api/private/laundry-watches",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: privateRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePrivateUser(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
        pairingService,
        "preferences:write",
        deviceSessionCookie.name,
      );
      const repository = options.campusUserRepository;
      if (repository === undefined) {
        return reply
          .code(503)
          .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
      }
      const activeCount = repository
        .listWatchesByUser(principal.userId)
        .filter((watch) => watch.status === "active").length;
      if (activeCount >= 64) {
        return reply
          .code(409)
          .send({ error: "LAUNDRY_WATCH_LIMIT_REACHED" });
      }
      const body = laundryWatchInputSchema.parse(request.body);
      const nowEpochMs = clock.now();
      const watch: LaundryWatch = {
        id: randomOpaqueToken("jbw_"),
        userId: principal.userId,
        ...body,
        status: "active",
        createdAtEpochMs: nowEpochMs,
        updatedAtEpochMs: nowEpochMs,
      };
      try {
        repository.createWatch(watch);
      } catch (error) {
        if (error instanceof CampusUserConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
      return reply.code(201).send(toApiLaundryWatch(watch));
    },
  );

  app.delete(
    "/api/private/laundry-watches/:id",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: privateRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePrivateUser(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
        pairingService,
        "preferences:write",
        deviceSessionCookie.name,
      );
      const repository = options.campusUserRepository;
      if (repository === undefined) {
        return reply
          .code(503)
          .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
      }
      const { id } = resourceParamsSchema.parse(request.params);
      if (
        !repository.setWatchStatus(
          id,
          principal.userId,
          "cancelled",
          clock.now(),
        )
      ) {
        return reply
          .code(404)
          .send({ error: "LAUNDRY_WATCH_NOT_FOUND" });
      }
      return reply.code(204).send();
    },
  );

  app.get("/api/private/laundry-queue", async (request, reply) => {
    const principal = await authenticatePrivateUser(
      request,
      desktopSessions,
      hasher,
      appSessionCookie.name,
      clock.now(),
      pairingService,
      "preferences:read",
      deviceSessionCookie.name,
    );
    const repository = options.campusUserRepository;
    if (repository === undefined) {
      return reply
        .code(503)
        .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
    }
    return {
      entries: repository
        .listQueueByUser(principal.userId, clock.now())
        .map(toApiLaundryQueueEntry),
    };
  });

  app.post(
    "/api/private/laundry-queue",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: privateRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePrivateUser(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
        pairingService,
        "preferences:write",
        deviceSessionCookie.name,
      );
      const repository = options.campusUserRepository;
      if (repository === undefined) {
        return reply
          .code(503)
          .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
      }
      const body = laundryQueueInputSchema.parse(request.body);
      const nowEpochMs = clock.now();
      const existing = repository
        .listQueueByUser(principal.userId, nowEpochMs)
        .find(
          (entry) =>
            entry.status === "waiting" &&
            entry.appliance === body.appliance &&
            entry.machineId === body.machineId,
        );
      if (existing !== undefined) {
        return reply
          .code(409)
          .send({ error: "LAUNDRY_QUEUE_ALREADY_JOINED" });
      }
      let entry: LaundryQueueEntry;
      try {
        entry = repository.enqueue({
          id: randomOpaqueToken("jbq_"),
          userId: principal.userId,
          ...body,
          status: "waiting",
          joinedAtEpochMs: nowEpochMs,
          leftAtEpochMs: null,
        });
      } catch (error) {
        if (error instanceof CampusUserConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
      return reply.code(201).send(toApiLaundryQueueEntry(entry));
    },
  );

  app.delete(
    "/api/private/laundry-queue/:id",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: privateRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePrivateUser(
        request,
        desktopSessions,
        hasher,
        appSessionCookie.name,
        clock.now(),
        pairingService,
        "preferences:write",
        deviceSessionCookie.name,
      );
      const repository = options.campusUserRepository;
      if (repository === undefined) {
        return reply
          .code(503)
          .send({ error: "PERSONAL_SERVICE_UNAVAILABLE" });
      }
      const { id } = resourceParamsSchema.parse(request.params);
      if (
        !repository.leaveQueue(
          id,
          principal.userId,
          "cancelled",
          clock.now(),
        )
      ) {
        return reply
          .code(404)
          .send({ error: "LAUNDRY_QUEUE_ENTRY_NOT_FOUND" });
      }
      return reply.code(204).send();
    },
  );

  app.get("/api/push/vapid-public-key", async (request, reply) => {
    await authenticateMobile(
      request,
      pairingService,
      "notifications:receive",
      deviceSessionCookie.name,
    );
    if (!options.vapidPublicKey) {
      return reply.code(503).send({ error: "WEB_PUSH_NOT_CONFIGURED" });
    }
    return { publicKey: options.vapidPublicKey };
  });

  app.put(
    "/api/push/subscriptions",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          keyGenerator: mobileRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticateMobile(
        request,
        pairingService,
        "notifications:receive",
        deviceSessionCookie.name,
      );
      const subscription = parsePushSubscription(request.body);
      const now = clock.now();
      const id = `jbps_${await hasher.hash(subscription.endpoint)}`;
      const previous = await pushSubscriptions.findById(id);
      if (
        previous &&
        (previous.userId !== principal.userId ||
          previous.deviceId !== principal.deviceId) &&
        previous.revokedReason !== "device-revoked"
      ) {
        return reply.code(409).send({ error: "PUSH_ENDPOINT_OWNED" });
      }
      const existing = await pushSubscriptions.listActiveByUserId(
        principal.userId,
      );
      for (const record of existing) {
        if (record.deviceId === principal.deviceId && record.id !== id) {
          await pushSubscriptions.revoke(record.id, {
            atEpochMs: now,
            reason: "replaced",
          });
        }
      }
      const stored = await pushSubscriptions.upsert({
        id,
        userId: principal.userId,
        deviceId: principal.deviceId,
        subscription,
        createdAtEpochMs:
          previous !== undefined &&
          previous.userId === principal.userId &&
          previous.deviceId === principal.deviceId
            ? previous.createdAtEpochMs
            : now,
        updatedAtEpochMs: now,
        revokedAtEpochMs: null,
        revokedReason: null,
      });
      if (!stored) {
        return reply.code(409).send({ error: "PUSH_SUBSCRIPTION_CONFLICT" });
      }
      return reply.code(previous ? 200 : 201).send({ subscriptionId: id });
    },
  );

  app.delete(
    "/api/push/subscriptions/:subscriptionId",
    async (request, reply) => {
      const principal = await authenticateMobile(
        request,
        pairingService,
        "notifications:receive",
        deviceSessionCookie.name,
      );
      const { subscriptionId } = pushSubscriptionParamsSchema.parse(
        request.params,
      );
      const record = await pushSubscriptions.findById(subscriptionId);
      if (
        record === undefined ||
        record.userId !== principal.userId ||
        record.deviceId !== principal.deviceId
      ) {
        return reply.code(404).send({ error: "PUSH_SUBSCRIPTION_NOT_FOUND" });
      }
      await pushSubscriptions.revoke(subscriptionId, {
        atEpochMs: clock.now(),
        reason: "user-unsubscribed",
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/push/test",
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 minute",
          keyGenerator: mobileRateLimitKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticateMobile(
        request,
        pairingService,
        "notifications:receive",
        deviceSessionCookie.name,
      );
      if (!options.pushDeliveryCoordinator) {
        return reply.code(503).send({ error: "WEB_PUSH_NOT_CONFIGURED" });
      }
      const subscriptions = (
        await pushSubscriptions.listActiveByUserId(principal.userId)
      ).filter((record) => record.deviceId === principal.deviceId);
      if (subscriptions.length === 0) {
        return reply.code(409).send({ error: "PUSH_SUBSCRIPTION_MISSING" });
      }
      const eventId = randomOpaqueToken("test_");
      const results = await Promise.all(
        subscriptions.map((subscription) =>
          options.pushDeliveryCoordinator!.deliver({
            subscriptionId: subscription.id,
            dedupeKey: `test:${eventId}:${subscription.id}`,
            payload: {
              version: 1,
              title: "Jungle Bell 테스트",
              body: "서버 Web Push 연결이 정상입니다.",
              path: "/app",
              tag: "jungle-bell-test",
            },
          }),
        ),
      );
      return reply.send({ results });
    },
  );

  if (options.webRoot !== undefined) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !isApiUrl(request.url) &&
        request.headers.accept?.includes("text/html")
      ) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "NOT_FOUND" });
    });
  }

  return app;
}

async function readAttendanceDashboard(
  userId: string,
  store: AttendanceSnapshotStore,
  nowEpochMs: number,
) {
  const snapshot = await store.getLatest(userId);
  return {
    status: snapshot === null ? "unavailable" : "available",
    freshness:
      snapshot === null
        ? "missing"
        : nowEpochMs - snapshot.collectedAtEpochMs <=
            ATTENDANCE_FRESH_WINDOW_MS
          ? "fresh"
          : "stale",
    lastSyncedAt:
      snapshot === null
        ? null
        : new Date(snapshot.collectedAtEpochMs).toISOString(),
    snapshot:
      snapshot === null
        ? null
        : {
            attendanceDate: snapshot.attendanceDate,
            cohortId: snapshot.cohortId,
            cohortStatus: snapshot.cohortStatus,
            cohortStartDate: snapshot.cohortStartDate,
            cohortEndDate: snapshot.cohortEndDate,
            morningChecked: snapshot.morningChecked,
            eveningChecked: snapshot.eveningChecked,
            collectedAt: new Date(
              snapshot.collectedAtEpochMs,
            ).toISOString(),
            sourceDeviceId: snapshot.sourceDeviceId,
            version: snapshot.version,
          },
  };
}

async function readDeviceDashboard(
  userId: string,
  store: DesktopIdentityStore,
  nowEpochMs: number,
) {
  return (await store.listDesktopDevices(userId)).map((device) =>
    toApiDesktopDevice(device, nowEpochMs),
  );
}

function toApiDesktopDevice(
  device: DesktopDeviceRecord,
  nowEpochMs: number,
) {
  return {
    id: device.desktopDeviceId,
    lastVerifiedAt: new Date(
      device.lastVerifiedAtEpochMs,
    ).toISOString(),
    lastSeenAt:
      device.lastSeenAtEpochMs === null
        ? null
        : new Date(device.lastSeenAtEpochMs).toISOString(),
    lmsSessionState: device.lmsSessionState,
    health:
      device.lastSeenAtEpochMs === null
        ? "unknown"
        : nowEpochMs - device.lastSeenAtEpochMs <=
            DESKTOP_ONLINE_WINDOW_MS
          ? "online"
          : "offline",
    appVersion: device.appVersion,
  };
}

async function authenticateDesktop(
  request: FastifyRequest,
  sessions: DesktopSessionStore,
  hasher: Sha256Hasher,
  cookieName: AppSessionCookieConfig["name"],
  now: number,
): Promise<DesktopSessionRecord> {
  const principal = await findValidAppSession(
    request,
    sessions,
    hasher,
    cookieName,
    now,
  );
  if (principal === null) {
    throw new PairingDomainError(
      "DEVICE_SESSION_INVALID",
      "App session is invalid.",
    );
  }
  return principal;
}

async function findValidAppSession(
  request: FastifyRequest,
  sessions: DesktopSessionStore,
  hasher: Sha256Hasher,
  cookieName: AppSessionCookieConfig["name"],
  now: number,
): Promise<DesktopSessionRecord | null> {
  const token = request.cookies[cookieName] ?? "";
  if (!/^jbas_[0-9a-f]{64}$/.test(token)) {
    return null;
  }
  const principal = await sessions.findByTokenHash(await hasher.hash(token));
  if (
    principal === null ||
    principal.revokedAtEpochMs !== null ||
    principal.expiresAtEpochMs <= now
  ) {
    return null;
  }
  return principal;
}

async function authenticateMobile(
  request: FastifyRequest,
  pairingService: PairingService,
  requiredScope: string,
  cookieName: DeviceSessionCookieConfig["name"],
): Promise<DeviceSessionPrincipal> {
  const token = request.cookies[cookieName] ?? "";
  return pairingService.authenticateDeviceSession(token, requiredScope);
}

async function authenticatePrivateUser(
  request: FastifyRequest,
  sessions: DesktopSessionStore,
  hasher: Sha256Hasher,
  cookieName: AppSessionCookieConfig["name"],
  now: number,
  pairingService: PairingService,
  requiredMobileScope: string,
  deviceCookieName: DeviceSessionCookieConfig["name"],
): Promise<{ readonly userId: string; readonly deviceId: string }> {
  const desktop = await findValidAppSession(
    request,
    sessions,
    hasher,
    cookieName,
    now,
  );
  if (desktop !== null) {
    return {
      userId: desktop.userId,
      deviceId: desktop.desktopDeviceId,
    };
  }
  const mobile = await authenticateMobile(
    request,
    pairingService,
    requiredMobileScope,
    deviceCookieName,
  );
  return { userId: mobile.userId, deviceId: mobile.deviceId };
}

async function issueAppSession(input: {
  readonly desktopDeviceId: string;
  readonly expiresAtEpochMs: number;
  readonly hasher: Sha256Hasher;
  readonly now: number;
  readonly sessions: DesktopSessionStore;
  readonly userId: string;
}): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomOpaqueToken("jbas_");
    const inserted = await input.sessions.insertReplacingActive({
      tokenHash: await input.hasher.hash(token),
      userId: input.userId,
      desktopDeviceId: input.desktopDeviceId,
      createdAtEpochMs: input.now,
      expiresAtEpochMs: input.expiresAtEpochMs,
      revokedAtEpochMs: null,
      version: 0,
    });
    if (inserted) {
      return token;
    }
  }
  throw new Error("DESKTOP_SESSION_COLLISION");
}

function setAppSessionCookie(
  reply: FastifyReply,
  config: AppSessionCookieConfig,
  token: string,
  ttlMs: number,
): void {
  reply.setCookie(config.name, token, {
    domain: config.domain,
    httpOnly: true,
    maxAge: Math.floor(ttlMs / 1000),
    path: "/",
    sameSite: "strict",
    secure: config.secure,
  });
}

function clearAppSessionCookie(
  reply: FastifyReply,
  config: AppSessionCookieConfig,
): void {
  reply.clearCookie(config.name, {
    domain: config.domain,
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: config.secure,
  });
}

function setDeviceSessionCookie(
  reply: FastifyReply,
  config: DeviceSessionCookieConfig,
  token: string,
  expiresAtEpochMs: number,
  nowEpochMs: number,
): void {
  const ttlMs = expiresAtEpochMs - nowEpochMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new PairingDomainError(
      "DEVICE_SESSION_EXPIRED",
      "Device session has expired.",
    );
  }
  reply.setCookie(config.name, token, {
    httpOnly: true,
    maxAge: Math.max(1, Math.floor(ttlMs / 1_000)),
    path: "/",
    sameSite: "strict",
    secure: config.secure,
  });
}

function clearDeviceSessionCookie(
  reply: FastifyReply,
  config: DeviceSessionCookieConfig,
): void {
  reply.clearCookie(config.name, {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: config.secure,
  });
}

function sendPairingError(reply: FastifyReply, error: PairingDomainError) {
  const unauthorized = new Set([
    "DEVICE_SESSION_EXPIRED",
    "DEVICE_SESSION_INVALID",
    "DEVICE_SESSION_REVOKED",
    "DEVICE_SESSION_SCOPE_DENIED",
  ]);
  const conflict = new Set([
    "PAIRING_ALREADY_USED",
    "PAIRING_NOT_CLAIMED",
    "PAIRING_EXPIRED",
  ]);
  const statusCode = unauthorized.has(error.code)
    ? 401
    : conflict.has(error.code)
      ? 409
      : error.code === "PAIRING_NOT_FOUND" ||
          error.code === "DEVICE_SESSION_NOT_FOUND"
        ? 404
        : 400;
  return reply.code(statusCode).send({ error: error.code });
}

function safeHashEquals(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function revokePushSubscriptionsForDevice(
  store: PushSubscriptionStore,
  userId: string,
  deviceId: string,
  atEpochMs: number,
): Promise<void> {
  const subscriptions = await store.listActiveByUserId(userId);
  for (const subscription of subscriptions) {
    if (subscription.deviceId === deviceId) {
      await store.revoke(subscription.id, {
        atEpochMs,
        reason: "device-revoked",
      });
    }
  }
}

function toApiMobileSession(
  session: DeviceSessionSummary,
  nowEpochMs: number,
  pushEnabled: boolean,
) {
  return {
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceLabel: session.deviceLabel,
    scopes: [...session.scopes],
    createdAt: new Date(session.createdAtEpochMs).toISOString(),
    expiresAt: new Date(session.expiresAtEpochMs).toISOString(),
    lastSeenAt: new Date(session.lastSeenAtEpochMs).toISOString(),
    pushEnabled,
    revokedAt:
      session.revokedAtEpochMs === null
        ? null
        : new Date(session.revokedAtEpochMs).toISOString(),
    status:
      session.revokedAtEpochMs !== null
        ? "revoked"
        : session.expiresAtEpochMs <= nowEpochMs
          ? "expired"
          : "active",
  };
}

class ManualPairingAttemptLimiter {
  private readonly attempts = new Map<
    string,
    { readonly count: number; readonly expiresAtEpochMs: number }
  >();

  consume(code: string, nowEpochMs: number): boolean {
    if (this.attempts.size > 10_000) {
      for (const [key, value] of this.attempts) {
        if (value.expiresAtEpochMs <= nowEpochMs) {
          this.attempts.delete(key);
        }
      }
    }
    const current = this.attempts.get(code);
    if (current === undefined || current.expiresAtEpochMs <= nowEpochMs) {
      this.attempts.set(code, {
        count: 1,
        expiresAtEpochMs: nowEpochMs + 2 * 60 * 1_000,
      });
      return true;
    }
    if (current.count >= 5) {
      return false;
    }
    this.attempts.set(code, {
      count: current.count + 1,
      expiresAtEpochMs: current.expiresAtEpochMs,
    });
    return true;
  }
}

function toApiMealRule(rule: {
  readonly enabled: boolean;
  readonly breakfast: boolean;
  readonly lunch: boolean;
  readonly dinner: boolean;
  readonly updatedAtEpochMs: number;
}) {
  return {
    enabled: rule.enabled,
    breakfast: rule.breakfast,
    lunch: rule.lunch,
    dinner: rule.dinner,
    updatedAtEpochMs: rule.updatedAtEpochMs,
  };
}

function toApiAttendanceRule(rule: {
  readonly enabled: boolean;
  readonly morning: boolean;
  readonly evening: boolean;
  readonly updatedAtEpochMs: number;
}) {
  return {
    enabled: rule.enabled,
    morning: rule.morning,
    evening: rule.evening,
    updatedAtEpochMs: rule.updatedAtEpochMs,
  };
}

function toApiLaundryWatch(watch: LaundryWatch) {
  return {
    id: watch.id,
    machineId: watch.machineId,
    appliance: watch.appliance,
    sessionId: watch.sessionId,
    notifyBeforeMinutes: watch.notifyBeforeMinutes,
    notifyWhenAvailable: watch.notifyWhenAvailable,
    status: watch.status,
    createdAtEpochMs: watch.createdAtEpochMs,
    updatedAtEpochMs: watch.updatedAtEpochMs,
  };
}

function toApiLaundryQueueEntry(entry: LaundryQueueEntry) {
  return {
    id: entry.id,
    machineId: entry.machineId,
    appliance: entry.appliance,
    status: entry.status,
    joinedAtEpochMs: entry.joinedAtEpochMs,
    leftAtEpochMs: entry.leftAtEpochMs,
    position: entry.status === "waiting" ? entry.position : null,
  };
}

function readPublicCampusSnapshot(
  kind: "laundry" | "meals",
  collector: BuildAppOptions["campusCollector"],
): PublicCampusSnapshot {
  if (collector !== undefined) {
    return collector.getLatest(kind);
  }
  return {
    kind,
    data: null,
    etag: null,
    savedAtEpochMs: null,
    lastCheckedAtEpochMs: null,
    stale: true,
    lastError: "CAMPUS_COLLECTOR_NOT_CONFIGURED",
  };
}

function recordDurableNotificationEvent(
  sink: NonNullable<BuildAppOptions["notificationEventSink"]>,
  event: NotificationSourceEvent,
): void {
  const result = sink.record(event);
  if (
    typeof result === "object" &&
    result !== null &&
    "then" in result &&
    typeof result.then === "function"
  ) {
    throw new TypeError(
      "Durable notification recording must complete synchronously.",
    );
  }
}

function recordBestEffortNotificationEvent(
  sink: BuildAppOptions["notificationEventSink"],
  event: NotificationSourceEvent,
  app: FastifyInstance,
): void {
  if (sink === undefined) return;
  try {
    sink.record(event);
  } catch (error) {
    app.log.warn(
      { err: error, kind: event.kind },
      "notification event enqueue failed",
    );
  }
}

export function attendanceNotificationEvent(
  snapshot: AttendanceSnapshotRecord,
  nowEpochMs: number,
): NotificationSourceEvent | null {
  return createAttendanceNotificationEvent(snapshot, nowEpochMs);
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function readClientErrorStatus(error: unknown): number | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("statusCode" in error)
  ) {
    return null;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500
    ? statusCode
    : null;
}

function isApiUrl(url: string): boolean {
  const pathname = url.split("?", 1)[0];
  return pathname === "/api" || pathname?.startsWith("/api/") === true;
}

function isHtmlContentType(
  value: string | number | string[] | undefined,
): boolean {
  const contentType = Array.isArray(value) ? value[0] : value;
  return (
    typeof contentType === "string" &&
    /^text\/html(?:;|$)/iu.test(contentType)
  );
}

function permitsMissingNativeOrigin(request: FastifyRequest): boolean {
  const pathname = request.url.split("?", 1)[0];
  if (
    request.method === "DELETE" &&
    pathname === "/api/private/desktop/session"
  ) {
    return true;
  }
  if (request.method !== "POST") return false;
  return (
    pathname === "/api/onboarding/lms-identity" ||
    pathname === "/api/dev/desktop-session" ||
    pathname === "/api/private/desktop/heartbeat" ||
    pathname === "/api/private/desktop/attendance-snapshot" ||
    /^\/api\/private\/desktop\/notifications\/[0-9a-f-]{36}\/ack$/u.test(
      pathname ?? "",
    )
  );
}

function cookieDomain(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, "");
}

function isValidIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const canonical = hostname
    .replace(/^\[|\]$/gu, "")
    .toLocaleLowerCase("en-US");
  if (canonical === "localhost" || canonical === "::1") {
    return true;
  }
  const octets = canonical.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet))
  );
}

function normalizePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN_INVALID");
  }
  if (
    url.origin !== value.replace(/\/$/u, "") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    throw new Error("PUBLIC_ORIGIN_INVALID");
  }
  return url.origin;
}
