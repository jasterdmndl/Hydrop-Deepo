import { describe, expect, it } from "vitest";
import { clockOffsetMs, idlePhase, postAuthRedirectPath, resolveLogoutOutcome, shouldSendHeartbeat } from "./idle";

describe("idle warning", () => {
  const expires = Date.parse("2026-11-18T01:15:00Z");

  it("stays active until one minute remains", () => {
    expect(idlePhase(expires - 60_001, expires).phase).toBe("active");
    expect(idlePhase(expires - 60_000, expires)).toEqual({ phase: "warning", secondsLeft: 60 });
    expect(idlePhase(expires - 1, expires)).toEqual({ phase: "warning", secondsLeft: 1 });
  });

  it("is expired at the server expiry time", () => {
    expect(idlePhase(expires, expires)).toEqual({ phase: "expired", secondsLeft: 0 });
  });

  it("measures the server clock offset", () => {
    expect(clockOffsetMs("2026-11-18T01:00:05Z", Date.parse("2026-11-18T01:00:00Z"))).toBe(5000);
  });

  it("limits heartbeats to one per minute", () => {
    expect(shouldSendHeartbeat(0, 59_999)).toBe(false);
    expect(shouldSendHeartbeat(0, 60_000)).toBe(true);
  });
});

describe("logout outcome", () => {
  it("confirms sign-out on HTTP 204 (no error)", () => {
    expect(resolveLogoutOutcome(undefined)).toEqual({ signedOut: true });
  });

  it("confirms sign-out when the server already ended the session (401)", () => {
    expect(resolveLogoutOutcome({ status: 401, message: "Please sign in." })).toEqual({ signedOut: true });
  });

  it("keeps the operator signed in on network failure with retry guidance", () => {
    const outcome = resolveLogoutOutcome(new Error("Cannot reach the station server."));
    expect(outcome.signedOut).toBe(false);
    if (!outcome.signedOut) {
      expect(outcome.errorMessage).toContain("Sign-out was not confirmed:");
      expect(outcome.errorMessage).toContain("Cannot reach the station server.");
      expect(outcome.errorMessage).toContain("please retry");
    }
  });

  it("keeps the operator signed in on server 500 error", () => {
    const outcome = resolveLogoutOutcome({ status: 500, message: "Something went wrong. Please try again." });
    expect(outcome.signedOut).toBe(false);
    if (!outcome.signedOut) {
      expect(outcome.errorMessage).toContain("Sign-out was not confirmed:");
      expect(outcome.errorMessage).toContain("Something went wrong. Please try again.");
    }
  });
});

describe("post-auth redirect path", () => {
  it("preserves module routes while loading and when already activated", () => {
    expect(postAuthRedirectPath("loading", false, "/calendar")).toBeNull();
    expect(postAuthRedirectPath("signed-in", false, "/calendar")).toBeNull();
  });

  it("redirects signed-out and unactivated sessions away from module routes", () => {
    expect(postAuthRedirectPath("signed-out", false, "/calendar")).toBe("/");
    expect(postAuthRedirectPath("signed-in", true, "/calendar")).toBe("/");
  });

  it("does not redirect when already at root", () => {
    expect(postAuthRedirectPath("signed-out", false, "/")).toBeNull();
    expect(postAuthRedirectPath("signed-in", true, "/")).toBeNull();
  });
});
