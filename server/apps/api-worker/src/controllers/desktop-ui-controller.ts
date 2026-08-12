import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { desktopUiPrincipal, publicOrigin, requirePairingSecret, subjectRateLimitKey } from "./auth";
import { createPersonalRoutes } from "./personal-controller";
import {
  deviceParamSchema,
  emptyObjectSchema,
  pairingApprovalSchema,
  pairingParamSchema,
  validationHook,
} from "./schemas";
import type { ApiEnvironment } from "./types";

export function createDesktopUiController(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();

  app.use("/api/desktop-ui/*", async (context, next) => {
    context.set("desktopUiPrincipal", await desktopUiPrincipal(context));
    await next();
  });

  app.get("/api/desktop-ui/attendance", async (context) => context.json(
    await context.var.services.attendance.readDesktop(context.var.desktopUiPrincipal.userId, Date.now()),
  ));

  app.route("/api/desktop-ui", createPersonalRoutes(
    async (context) => context.var.desktopUiPrincipal,
    { includeLegacyAttendancePreferences: false },
  ));

  app.get("/api/desktop-ui/mobile-sessions", async (context) => context.json(
    await context.var.services.desktop.listMobileSessions(context.var.desktopUiPrincipal.userId, Date.now()),
  ));
  app.delete(
    "/api/desktop-ui/mobile-sessions/:id",
    zValidator("param", deviceParamSchema, validationHook),
    async (context) => {
      if (!(await context.var.services.desktop.revokeMobileSession(
        context.var.desktopUiPrincipal.userId,
        context.req.valid("param").id,
        Date.now(),
      ))) return context.json({ error: "DEVICE_NOT_FOUND" }, 404);
      return context.body(null, 204);
    },
  );

  app.post(
    "/api/desktop-ui/pairings",
    zValidator("json", emptyObjectSchema, validationHook),
    async (context) => {
      const principal = context.var.desktopUiPrincipal;
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
    },
  );
  app.get(
    "/api/desktop-ui/pairings/:id",
    zValidator("param", pairingParamSchema, validationHook),
    async (context) => {
      const result = await context.var.services.pairings.status(
        context.var.desktopUiPrincipal,
        context.req.valid("param").id,
        Date.now(),
      );
      return result ? context.json(result) : context.json({ error: "PAIRING_NOT_FOUND" }, 404);
    },
  );
  app.post(
    "/api/desktop-ui/pairings/:id/approve",
    zValidator("param", pairingParamSchema, validationHook),
    zValidator("json", pairingApprovalSchema, validationHook),
    async (context) => {
      if (context.req.valid("json").claimId !== context.req.valid("param").id) {
        return context.json({ error: "PAIRING_CLAIM_MISMATCH" }, 409);
      }
      await context.var.services.pairings.approve({
        principal: context.var.desktopUiPrincipal,
        pairingId: context.req.valid("param").id,
        pairingSecret: requirePairingSecret(context.env),
        nowEpochMs: Date.now(),
      });
      return context.body(null, 204);
    },
  );

  return app;
}
