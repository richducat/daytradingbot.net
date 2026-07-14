import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LicenseService,
  claimsSigningBytes,
  type LeaseRecord,
  type LicenseRepository,
} from "./licensing.js";

const issuedAt = new Date("2026-07-13T12:00:00.000Z");
const licenseId = "4cb19476-a028-4377-9741-2d0f130d49b1";

function signingKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

function repository(): LicenseRepository {
  return {
    async activate(request): Promise<LeaseRecord> {
      return {
        leaseId: request.leaseId,
        licenseId,
        issuedAtUnix: Math.floor(request.issuedAt.getTime() / 1_000),
        expiresAtUnix: Math.floor(request.expiresAt.getTime() / 1_000),
      };
    },
    async renew(request): Promise<LeaseRecord> {
      return {
        leaseId: request.leaseId,
        licenseId,
        issuedAtUnix: Math.floor(request.issuedAt.getTime() / 1_000),
        expiresAtUnix: Math.floor(request.expiresAt.getTime() / 1_000),
      };
    },
  };
}

describe("license service", () => {
  it("issues a device-bound seven-day lease with an Ed25519 signature", async () => {
    const keys = signingKeys();
    const service = new LicenseService(repository(), keys.privatePem, "p".repeat(32), () => issuedAt);
    const devicePublicKey = Buffer.alloc(32, 9).toString("base64url");

    const result = await service.activate({
      licenseCode: "DTB-FOUNDER-TEST-0001",
      devicePublicKey,
      platform: "macos-universal",
    });

    expect(result.activationToken).toMatch(/^dtb_act_[A-Za-z0-9_-]{43}$/);
    expect(result.signedLease.claims.device_public_key).toEqual([...Buffer.alloc(32, 9)]);
    expect(result.signedLease.claims.expires_at_unix - result.signedLease.claims.issued_at_unix)
      .toBe(7 * 24 * 60 * 60);
    expect(verify(
      null,
      claimsSigningBytes(result.signedLease.claims),
      keys.publicKey,
      Buffer.from(result.signedLease.signature, "base64url"),
    )).toBe(true);
  });

  it("does not issue a lease for a malformed purchase code", async () => {
    const keys = signingKeys();
    const service = new LicenseService(repository(), keys.privatePem, "p".repeat(32), () => issuedAt);

    await expect(service.activate({
      licenseCode: "not-a-code",
      devicePublicKey: Buffer.alloc(32, 8).toString("base64url"),
      platform: "macos-universal",
    })).rejects.toMatchObject({ code: "invalid_license" });
  });
});
