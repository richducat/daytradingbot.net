import { describe, expect, it } from "vitest";
import { siteConfig } from "./siteConfig";
import { browserSessionPaths } from "./WebApp";

describe("customer website contract", () => {
  it("uses the website API only for sign-in and sign-out", () => {
    expect(Object.values(browserSessionPaths)).toEqual([
      "/v1/web/session",
      "/v1/web/session/logout",
    ]);
  });

  it("routes Robinhood trading to the Mac app", () => {
    const robinhood = siteConfig.accounts.find((account) => account.name === "Robinhood");
    expect(robinhood?.status).toContain("Mac app");
    expect(robinhood?.status).not.toContain("browser app");
    expect(siteConfig.macosDownloadUrl).toMatch(/^https:\/\//);
  });
});
