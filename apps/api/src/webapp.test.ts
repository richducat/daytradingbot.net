import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  parseSessionCookie,
  sessionCookie,
  webSessionCookieName,
  workerSecretMatches,
} from "./webapp.js";

describe("browser app security helpers", () => {
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

  it("rejects malformed cookies and worker secrets", () => {
    expect(parseSessionCookie(`${webSessionCookieName}=short`)).toBeUndefined();
    expect(workerSecretMatches("x".repeat(32), "x".repeat(32))).toBe(true);
    expect(workerSecretMatches("x".repeat(32), "x".repeat(31))).toBe(false);
    expect(workerSecretMatches("short", "short")).toBe(false);
  });
});
