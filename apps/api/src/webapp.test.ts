import { describe, expect, it, vi } from "vitest";
import {
  clearSessionCookie,
  MySqlWebAppRepository,
  parseSessionCookie,
  sessionCookie,
  WebAppService,
  webSessionCookieName,
} from "./webapp.js";

describe("browser access security", () => {
  it("uses a host-only secure HttpOnly session cookie", () => {
    const token = "a".repeat(43);
    const header = sessionCookie(token);
    expect(header).toContain(`${webSessionCookieName}=${token}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).not.toContain("Domain=");
    expect(parseSessionCookie(`unrelated=x; ${webSessionCookieName}=${token}`)).toBe(token);
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("rejects malformed session cookies", () => {
    expect(parseSessionCookie(`${webSessionCookieName}=short`)).toBeUndefined();
    expect(parseSessionCookie(undefined)).toBeUndefined();
  });

  it("returns entitlement only and enforces the session CSRF token", async () => {
    const repository = {
      createSession: vi.fn(),
      authenticate: vi.fn(),
      revokeSession: vi.fn(async () => undefined),
    };
    const service = new WebAppService(repository as unknown as MySqlWebAppRepository);
    const session = {
      licenseId: "license-1",
      sessionId: "session-1",
      csrfToken: "c".repeat(43),
      expiresAt: new Date("2026-07-22T12:00:00.000Z"),
    };

    expect(await service.dashboard(session.licenseId)).toEqual({
      app: "daytradingbot-web",
      entitlement: { status: "active" },
    });
    expect(() => service.requireCsrf(session, "x".repeat(43))).toThrowError(
      expect.objectContaining({ code: "invalid_csrf" }),
    );
    expect(() => service.requireCsrf(session, session.csrfToken)).not.toThrow();
    await service.logout(session);
    expect(repository.revokeSession).toHaveBeenCalledWith("session-1");
  });
});
