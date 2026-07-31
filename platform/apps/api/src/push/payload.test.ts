import { describe, expect, it } from "vitest";

import {
  PushPayloadError,
  parsePushSubscription,
  serializePushPayload,
} from "./payload";

describe("serializePushPayload", () => {
  it("accepts the strict versioned notification contract", () => {
    const serialized = serializePushPayload({
      version: 1,
      title: "점심 메뉴가 등록됐습니다",
      body: "닭갈비 · 들기름막국수",
      path: "/app/meals?date=2026-07-30",
      tag: "meal:2026-07-30:lunch",
    });

    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      title: "점심 메뉴가 등록됐습니다",
      body: "닭갈비 · 들기름막국수",
      path: "/app/meals?date=2026-07-30",
      tag: "meal:2026-07-30:lunch",
    });
  });

  it.each([
    {
      version: 1,
      title: "외부 링크",
      body: "열면 안 됩니다",
      path: "https://evil.example/phish",
      tag: "unsafe",
    },
    {
      version: 1,
      title: "프로토콜 상대 링크",
      body: "열면 안 됩니다",
      path: "//evil.example/phish",
      tag: "unsafe",
    },
    {
      version: 1,
      title: "백슬래시 링크",
      body: "열면 안 됩니다",
      path: "/\\evil.example/phish",
      tag: "unsafe",
    },
    {
      version: 1,
      title: "인코딩된 백슬래시 링크",
      body: "열면 안 됩니다",
      path: "/%5cevil.example/phish",
      tag: "unsafe",
    },
    {
      version: 1,
      title: "추가 필드",
      body: "엄격한 계약이어야 합니다",
      path: "/app",
      tag: "strict",
      image: "https://evil.example/tracker.png",
    },
  ])("rejects an unsafe or non-strict payload", (payload) => {
    expect(() => serializePushPayload(payload)).toThrow(PushPayloadError);
  });

  it("enforces the UTF-8 payload byte limit", () => {
    const oversized = {
      version: 1,
      title: "한".repeat(80),
      body: "가".repeat(240),
      path: `/${"나".repeat(511)}`,
      tag: "a".repeat(64),
    };

    expect(() => serializePushPayload(oversized)).toThrowError(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
    );
  });
});

describe("parsePushSubscription", () => {
  it("normalizes a browser subscription", () => {
    expect(
      parsePushSubscription({
        endpoint: "https://updates.push.services.mozilla.com/wpush/one",
        expirationTime: null,
        keys: {
          auth: "a".repeat(22),
          p256dh: "b".repeat(87),
        },
      }),
    ).toEqual({
      endpoint: "https://updates.push.services.mozilla.com/wpush/one",
      expirationTime: null,
      keys: {
        auth: "a".repeat(22),
        p256dh: "b".repeat(87),
      },
    });
  });

  it.each([
    "http://push.example.test/subscriptions/one",
    "https://user:password@push.example.test/subscriptions/one",
    "https://push.example.test/subscriptions/one",
    "https://127.0.0.1/subscriptions/one",
    "https://169.254.169.254/latest/meta-data",
    "https://web.push.apple.com.evil.test/subscriptions/one",
    "https://web.push.apple.com:8443/subscriptions/one",
    "not-a-url",
  ])("rejects an invalid endpoint: %s", (endpoint) => {
    expect(() =>
      parsePushSubscription({
        endpoint,
        expirationTime: null,
        keys: {
          auth: "a".repeat(22),
          p256dh: "b".repeat(87),
        },
      }),
    ).toThrow(PushPayloadError);
  });

  it.each([
    "https://fcm.googleapis.com/fcm/send/one",
    "https://updates.push.services.mozilla.com/wpush/v2/one",
    "https://web.push.apple.com/Qexample",
    "https://wns2-by3p.notify.windows.com/?token=one",
  ])("accepts a known browser push service: %s", (endpoint) => {
    expect(() =>
      parsePushSubscription({
        endpoint,
        expirationTime: null,
        keys: {
          auth: "a".repeat(22),
          p256dh: "b".repeat(87),
        },
      }),
    ).not.toThrow();
  });
});
