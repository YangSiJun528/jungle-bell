import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import { RenewalError, type Principal } from "../domain/session";
import { sha256Hex } from "@jungle-bell/backend-common/renewal/crypto";
import type { ApiBindings, ApiEnvironment } from "./types";

export function publicOrigin(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

export function rateLimitKey(
  context: Context<ApiEnvironment>,
  scope: "desktop-enrollment" | "manual-pairing",
  discriminator = "",
): Promise<string> {
  const clientIp = context.req.header("CF-Connecting-IP") ?? "unavailable-client-ip";
  return sha256Hex(`jungle-bell:rate-limit:v2\0${scope}\0${clientIp}\0${discriminator}`);
}

export function subjectRateLimitKey(scope: "pairing-creation", discriminator: string): Promise<string> {
  return sha256Hex(`jungle-bell:subject-rate-limit:v2\0${scope}\0${discriminator}`);
}

function bearerToken(context: Context<ApiEnvironment>): string {
  const match = /^Bearer (\S+)$/u.exec(context.req.header("Authorization") ?? "");
  if (!match?.[1]) throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
  return match[1];
}

export function desktopPrincipal(context: Context<ApiEnvironment>): Promise<Principal> {
  return context.var.services.pairings.authenticate(bearerToken(context), Date.now(), "desktop");
}

export function mobilePrincipal(context: Context<ApiEnvironment>): Promise<Principal> {
  const token = readCookie(context.req.header("Cookie"), "__Host-jb_device")
    ?? readCookie(context.req.header("Cookie"), "jb_device")
    ?? "";
  return context.var.services.pairings.authenticate(token, Date.now(), "mobile");
}

export function pendingClaimReceipt(context: Context<ApiEnvironment>): string {
  const receipt = readCookie(context.req.header("Cookie"), "__Host-jb_pending_claim")
    ?? readCookie(context.req.header("Cookie"), "jb_pending_claim");
  if (!receipt) throw new RenewalError("PAIRING_RECEIPT_INVALID", 401);
  return receipt;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function requirePairingSecret(env: ApiBindings): string {
  if (!env.PAIRING_SECRET || new TextEncoder().encode(env.PAIRING_SECRET).byteLength < 32) {
    throw new RenewalError("PAIRING_SERVICE_UNAVAILABLE", 503);
  }
  return env.PAIRING_SECRET;
}

export function configuredVapidPublicKey(env: ApiBindings): string | null {
  return env.VAPID_PUBLIC_KEY?.trim() || null;
}

export function setMobileSessionCookie(context: Context<ApiEnvironment>, token: string, expiresAtEpochMs: number): void {
  const secure = new URL(context.req.url).protocol === "https:";
  setCookie(context, secure ? "__Host-jb_device" : "jb_device", token, {
    httpOnly: true, secure, sameSite: "Strict", path: "/", expires: new Date(expiresAtEpochMs),
    maxAge: Math.max(0, Math.floor((expiresAtEpochMs - Date.now()) / 1_000)),
  });
}

export function setPendingClaimCookie(context: Context<ApiEnvironment>, receipt: string, expiresAtEpochMs: number): void {
  const secure = new URL(context.req.url).protocol === "https:";
  setCookie(context, secure ? "__Host-jb_pending_claim" : "jb_pending_claim", receipt, {
    httpOnly: true, secure, sameSite: "Strict", path: "/", expires: new Date(expiresAtEpochMs),
    maxAge: Math.max(0, Math.floor((expiresAtEpochMs - Date.now()) / 1_000)),
  });
}

export function clearPendingClaimCookie(context: Context<ApiEnvironment>): void {
  const secure = new URL(context.req.url).protocol === "https:";
  setCookie(context, secure ? "__Host-jb_pending_claim" : "jb_pending_claim", "", {
    httpOnly: true, secure, sameSite: "Strict", path: "/", maxAge: 0,
  });
}

export function clearMobileSessionCookie(context: Context<ApiEnvironment>): void {
  const secure = new URL(context.req.url).protocol === "https:";
  setCookie(context, secure ? "__Host-jb_device" : "jb_device", "", {
    httpOnly: true, secure, sameSite: "Strict", path: "/", maxAge: 0,
  });
}
