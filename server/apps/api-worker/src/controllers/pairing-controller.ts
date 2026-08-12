import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  clearPendingClaimCookie,
  desktopPrincipal,
  pendingClaimReceipt,
  publicOrigin,
  rateLimitKey,
  requirePairingSecret,
  setMobileSessionCookie,
  setPendingClaimCookie,
  subjectRateLimitKey,
} from "./auth";
import { emptyObjectSchema, manualClaimSchema, pairingParamSchema, qrClaimSchema, validationHook } from "./schemas";
import type { ApiEnvironment } from "./types";

export function createPairingController(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  app.post("/api/pairings", zValidator("json", emptyObjectSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    const result = await context.var.services.pairings.create(
      principal,
      await subjectRateLimitKey("pairing-creation", principal.installationId),
      requirePairingSecret(context.env),
      publicOrigin(context.req.url),
      Date.now(),
    );
    return result
      ? context.json(result, 201)
      : context.json({ error: "PAIRING_CREATION_RATE_LIMITED" }, 429);
  });
  app.post(
    "/api/pairings/:id/claims",
    zValidator("param", pairingParamSchema, validationHook),
    zValidator("json", qrClaimSchema, validationHook),
    async (context) => {
      const body = context.req.valid("json");
      const claim = await context.var.services.pairings.claim({
        pairingSecret: requirePairingSecret(context.env),
        pairingId: context.req.valid("param").id,
        challenge: body.challenge,
        installationId: body.installationId,
        deviceLabel: body.deviceLabel,
        nowEpochMs: Date.now(),
      });
      setPendingClaimCookie(context, claim.claimReceipt, claim.expiresAtEpochMs);
      return context.json({ claimId: claim.claimId, status: claim.status }, 201);
    },
  );
  app.post("/api/pairings/claims", zValidator("json", manualClaimSchema, validationHook), async (context) => {
    const body = context.req.valid("json");
    const claim = await context.var.services.pairings.claim({
      pairingSecret: requirePairingSecret(context.env),
      manualCode: body.manualCode,
      manualRateKeys: await Promise.all([
        rateLimitKey(context, "manual-pairing"),
        rateLimitKey(context, "manual-pairing", `installation:${body.installationId}`),
      ]),
      installationId: body.installationId,
      deviceLabel: body.deviceLabel,
      nowEpochMs: Date.now(),
    });
    setPendingClaimCookie(context, claim.claimReceipt, claim.expiresAtEpochMs);
    return context.json({ claimId: claim.claimId, status: claim.status }, 201);
  });
  app.get("/api/pairings/:id", zValidator("param", pairingParamSchema, validationHook), async (context) => {
    const result = await context.var.services.pairings.status(
      await desktopPrincipal(context),
      context.req.valid("param").id,
      Date.now(),
    );
    return result ? context.json(result) : context.json({ error: "PAIRING_NOT_FOUND" }, 404);
  });
  app.post(
    "/api/pairings/:id/approve",
    zValidator("param", pairingParamSchema, validationHook),
    zValidator("json", emptyObjectSchema, validationHook),
    async (context) => {
      await context.var.services.pairings.approve({
        principal: await desktopPrincipal(context),
        pairingId: context.req.valid("param").id,
        pairingSecret: requirePairingSecret(context.env),
        nowEpochMs: Date.now(),
      });
      return context.body(null, 204);
    },
  );
  app.post(
    "/api/pairings/:id/complete",
    zValidator("param", pairingParamSchema, validationHook),
    zValidator("json", emptyObjectSchema, validationHook),
    async (context) => {
      const result = await context.var.services.pairings.complete({
        pairingId: context.req.valid("param").id,
        claimReceipt: pendingClaimReceipt(context),
        pairingSecret: requirePairingSecret(context.env),
        nowEpochMs: Date.now(),
      });
      clearPendingClaimCookie(context);
      setMobileSessionCookie(context, result.token, result.expiresAtEpochMs);
      return context.body(null, 204);
    },
  );
  return app;
}
