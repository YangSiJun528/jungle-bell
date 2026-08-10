import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import {
  approvePairing, claimPairing, completePairing, createPairing, pairingStatusAt,
} from "../../renewal/service";
import {
  clearPendingClaimCookie, desktopPrincipal, pendingClaimReceipt, publicOrigin, rateLimitKey,
  requirePairingSecret, setMobileSessionCookie, setPendingClaimCookie,
  subjectRateLimitKey,
} from "../auth";
import { PAIRING_CREATION_POLICY } from "../../domain/enrollment-policy";
import { emptyObjectSchema, manualClaimSchema, pairingParamSchema, qrClaimSchema, validationHook } from "../schemas";
import type { ApiEnvironment } from "../types";

export function registerPairingRoutes(app: Hono<ApiEnvironment>): void {
  app.post("/api/pairings", zValidator("json", emptyObjectSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    const now = Date.now();
    if (!(await context.var.renewalStore.consumePairingCreationAttempt(
      await subjectRateLimitKey("pairing-creation", principal.installationId),
      now,
      PAIRING_CREATION_POLICY.windowMs,
      PAIRING_CREATION_POLICY.installationAttemptLimit,
    ))) return context.json({ error: "PAIRING_CREATION_RATE_LIMITED" }, 429);
    return context.json(await createPairing({
      principal, store: context.var.renewalStore, pairingSecret: requirePairingSecret(context.env),
      publicOrigin: publicOrigin(context.req.url), nowEpochMs: now,
    }), 201);
  });

  app.post("/api/pairings/:id/claims", zValidator("param", pairingParamSchema, validationHook),
    zValidator("json", qrClaimSchema, validationHook), async (context) => {
      const body = context.req.valid("json");
      const claim = await claimPairing({
        store: context.var.renewalStore, pairingSecret: requirePairingSecret(context.env),
        pairingId: context.req.valid("param").id, challenge: body.challenge,
        installationId: body.installationId, deviceLabel: body.deviceLabel, nowEpochMs: Date.now(),
      });
      setPendingClaimCookie(context, claim.claimReceipt, claim.expiresAtEpochMs);
      return context.json({ claimId: claim.claimId, status: claim.status }, 201);
    });

  app.post("/api/pairings/claims", zValidator("json", manualClaimSchema, validationHook), async (context) => {
    const body = context.req.valid("json");
    const claim = await claimPairing({
      store: context.var.renewalStore, pairingSecret: requirePairingSecret(context.env), manualCode: body.manualCode,
      manualRateKeys: await Promise.all([
        rateLimitKey(context, "manual-pairing"),
        rateLimitKey(context, "manual-pairing", `installation:${body.installationId}`),
      ]),
      installationId: body.installationId, deviceLabel: body.deviceLabel, nowEpochMs: Date.now(),
    });
    setPendingClaimCookie(context, claim.claimReceipt, claim.expiresAtEpochMs);
    return context.json({ claimId: claim.claimId, status: claim.status }, 201);
  });

  app.get("/api/pairings/:id", zValidator("param", pairingParamSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    const pairing = await context.var.renewalStore.getPairing(context.req.valid("param").id);
    if (!pairing || pairing.userId !== principal.userId || pairing.desktopInstallationId !== principal.installationId) {
      return context.json({ error: "PAIRING_NOT_FOUND" }, 404);
    }
    const status = pairingStatusAt(pairing, Date.now());
    return context.json({
      status,
      claim: status === "claimed" ? {
        claimId: pairing.id, deviceLabel: pairing.mobileLabel,
        confirmationCode: pairing.mobileInstallationId?.slice(-4).toUpperCase() ?? null,
      } : null,
    });
  });

  app.post("/api/pairings/:id/approve", zValidator("param", pairingParamSchema, validationHook),
    zValidator("json", emptyObjectSchema, validationHook), async (context) => {
      await approvePairing({
        store: context.var.renewalStore, principal: await desktopPrincipal(context),
        pairingId: context.req.valid("param").id, pairingSecret: requirePairingSecret(context.env), nowEpochMs: Date.now(),
      });
      return context.body(null, 204);
    });

  app.post("/api/pairings/:id/complete", zValidator("param", pairingParamSchema, validationHook),
    zValidator("json", emptyObjectSchema, validationHook), async (context) => {
      const pairingId = context.req.valid("param").id;
      const result = await completePairing({
        store: context.var.renewalStore, pairingId, claimReceipt: pendingClaimReceipt(context),
        pairingSecret: requirePairingSecret(context.env), nowEpochMs: Date.now(),
      });
      clearPendingClaimCookie(context);
      setMobileSessionCookie(context, result.token, result.expiresAtEpochMs);
      return context.body(null, 204);
    });
}
