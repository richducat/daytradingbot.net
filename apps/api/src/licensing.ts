import {
  createHmac,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";

const LEASE_FORMAT_VERSION = 1;
const LEASE_SECONDS = 7 * 24 * 60 * 60;

export type DesktopPlatform = "macos-universal";

export type SignedLeaseWire = {
  claims: {
    version: number;
    lease_id: string;
    license_id: string;
    device_public_key: number[];
    issued_at_unix: number;
    expires_at_unix: number;
    allows_entries: boolean;
  };
  signature: string;
};

export type ActivationResponse = {
  activated: true;
  expiresAt: string;
  activationToken?: string;
  signedLease: SignedLeaseWire;
};

export type LeaseRecord = {
  leaseId: string;
  licenseId: string;
  issuedAtUnix: number;
  expiresAtUnix: number;
};

export type ActivateRepositoryRequest = {
  licenseSecretHash: Buffer;
  devicePublicKey: Buffer;
  platform: DesktopPlatform;
  activationSecretHash: Buffer;
  leaseId: string;
  issuedAt: Date;
  expiresAt: Date;
};

export type RenewRepositoryRequest = {
  activationSecretHash: Buffer;
  devicePublicKey: Buffer;
  leaseId: string;
  issuedAt: Date;
  expiresAt: Date;
};

export interface LicenseRepository {
  activate(request: ActivateRepositoryRequest): Promise<LeaseRecord>;
  renew(request: RenewRepositoryRequest): Promise<LeaseRecord>;
}

export type LicenseServiceErrorCode =
  | "invalid_license"
  | "device_already_active"
  | "invalid_activation"
  | "activation_unavailable";

export class LicenseServiceError extends Error {
  constructor(readonly code: LicenseServiceErrorCode) {
    super(code);
    this.name = "LicenseServiceError";
  }
}

function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new LicenseServiceError("activation_unavailable");
  return Buffer.from(hex, "hex");
}

export function claimsSigningBytes(claims: SignedLeaseWire["claims"]): Buffer {
  const bytes = Buffer.alloc(2 + 16 + 16 + 32 + 8 + 8 + 1);
  let offset = 0;
  bytes.writeUInt16BE(claims.version, offset);
  offset += 2;
  uuidBytes(claims.lease_id).copy(bytes, offset);
  offset += 16;
  uuidBytes(claims.license_id).copy(bytes, offset);
  offset += 16;
  Buffer.from(claims.device_public_key).copy(bytes, offset);
  offset += 32;
  bytes.writeBigInt64BE(BigInt(claims.issued_at_unix), offset);
  offset += 8;
  bytes.writeBigInt64BE(BigInt(claims.expires_at_unix), offset);
  offset += 8;
  bytes.writeUInt8(claims.allows_entries ? 1 : 0, offset);
  return bytes;
}

function normalizedLicenseCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^DTB-[A-Z0-9-]{12,80}$/.test(normalized)) {
    throw new LicenseServiceError("invalid_license");
  }
  return normalized;
}

function activationToken(): string {
  return `dtb_act_${randomBytes(32).toString("base64url")}`;
}

export function hashLicenseSecret(secretPepper: string, secret: string): Buffer {
  if (secretPepper.length < 32) throw new LicenseServiceError("activation_unavailable");
  return createHmac("sha256", secretPepper).update(secret, "utf8").digest();
}

function decodeDevicePublicKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new LicenseServiceError("invalid_activation");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32) throw new LicenseServiceError("invalid_activation");
  return decoded;
}

export class LicenseService {
  private readonly signingKey: KeyObject;

  constructor(
    private readonly repository: LicenseRepository,
    signingPrivateKeyPem: string,
    private readonly secretPepper: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (secretPepper.length < 32) throw new LicenseServiceError("activation_unavailable");
    try {
      this.signingKey = createPrivateKey(signingPrivateKeyPem);
    } catch {
      throw new LicenseServiceError("activation_unavailable");
    }
    if (this.signingKey.asymmetricKeyType !== "ed25519") {
      throw new LicenseServiceError("activation_unavailable");
    }
  }

  async activate(input: {
    licenseCode: string;
    devicePublicKey: string;
    platform: DesktopPlatform;
  }): Promise<ActivationResponse> {
    const code = normalizedLicenseCode(input.licenseCode);
    const devicePublicKey = decodeDevicePublicKey(input.devicePublicKey);
    const token = activationToken();
    const window = this.leaseWindow();
    const record = await this.repository.activate({
      licenseSecretHash: this.hashSecret(code),
      devicePublicKey,
      platform: input.platform,
      activationSecretHash: this.hashSecret(token),
      leaseId: randomUUID(),
      ...window,
    });
    return {
      ...this.signedResponse(record, devicePublicKey),
      activationToken: token,
    };
  }

  async renew(input: {
    activationToken: string;
    devicePublicKey: string;
  }): Promise<ActivationResponse> {
    if (!/^dtb_act_[A-Za-z0-9_-]{43}$/.test(input.activationToken)) {
      throw new LicenseServiceError("invalid_activation");
    }
    const devicePublicKey = decodeDevicePublicKey(input.devicePublicKey);
    const record = await this.repository.renew({
      activationSecretHash: this.hashSecret(input.activationToken),
      devicePublicKey,
      leaseId: randomUUID(),
      ...this.leaseWindow(),
    });
    return this.signedResponse(record, devicePublicKey);
  }

  private leaseWindow(): { issuedAt: Date; expiresAt: Date } {
    const issuedAtUnix = Math.floor(this.now().getTime() / 1_000);
    return {
      issuedAt: new Date(issuedAtUnix * 1_000),
      expiresAt: new Date((issuedAtUnix + LEASE_SECONDS) * 1_000),
    };
  }

  private hashSecret(secret: string): Buffer {
    return hashLicenseSecret(this.secretPepper, secret);
  }

  private signedResponse(record: LeaseRecord, devicePublicKey: Buffer): ActivationResponse {
    const claims: SignedLeaseWire["claims"] = {
      version: LEASE_FORMAT_VERSION,
      lease_id: record.leaseId,
      license_id: record.licenseId,
      device_public_key: [...devicePublicKey],
      issued_at_unix: record.issuedAtUnix,
      expires_at_unix: record.expiresAtUnix,
      allows_entries: true,
    };
    const signature = sign(null, claimsSigningBytes(claims), this.signingKey).toString("base64url");
    return {
      activated: true,
      expiresAt: new Date(record.expiresAtUnix * 1_000).toISOString(),
      signedLease: { claims, signature },
    };
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}

export class PostgresLicenseRepository implements LicenseRepository {
  constructor(private readonly pool: Pool) {}

  async activate(request: ActivateRepositoryRequest): Promise<LeaseRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const licenseResult = await client.query<{ license_id: string; status: string }>(
        `SELECT license_id, status
           FROM licenses
          WHERE license_secret_hash = $1
          FOR UPDATE`,
        [request.licenseSecretHash],
      );
      const license = licenseResult.rows[0];
      if (!license || license.status !== "active") {
        throw new LicenseServiceError("invalid_license");
      }

      const activationResult = await client.query<{
        activation_id: string;
        device_public_key: Buffer;
        platform: DesktopPlatform;
      }>(
        `SELECT activation_id, device_public_key, platform
           FROM activations
          WHERE license_id = $1 AND status = 'active'`,
        [license.license_id],
      );
      const active = activationResult.rows[0];
      let activationId: string;
      if (active) {
        if (!active.device_public_key.equals(request.devicePublicKey) || active.platform !== request.platform) {
          throw new LicenseServiceError("device_already_active");
        }
        activationId = active.activation_id;
        await client.query(
          `UPDATE activations
              SET activation_secret_hash = $2
            WHERE activation_id = $1`,
          [activationId, request.activationSecretHash],
        );
      } else {
        const inserted = await client.query<{ activation_id: string }>(
          `INSERT INTO activations
             (license_id, device_public_key, platform, activation_secret_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING activation_id`,
          [
            license.license_id,
            request.devicePublicKey,
            request.platform,
            request.activationSecretHash,
          ],
        );
        const activation = inserted.rows[0];
        if (!activation) throw new LicenseServiceError("activation_unavailable");
        activationId = activation.activation_id;
      }

      await this.replaceLease(client, activationId, request);
      await client.query("COMMIT");
      return {
        leaseId: request.leaseId,
        licenseId: license.license_id,
        issuedAtUnix: Math.floor(request.issuedAt.getTime() / 1_000),
        expiresAtUnix: Math.floor(request.expiresAt.getTime() / 1_000),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async renew(request: RenewRepositoryRequest): Promise<LeaseRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ activation_id: string; license_id: string }>(
        `SELECT a.activation_id, a.license_id
           FROM activations a
           JOIN licenses l ON l.license_id = a.license_id
          WHERE a.activation_secret_hash = $1
            AND a.device_public_key = $2
            AND a.status = 'active'
            AND l.status = 'active'
          FOR UPDATE OF a, l`,
        [request.activationSecretHash, request.devicePublicKey],
      );
      const activation = result.rows[0];
      if (!activation) throw new LicenseServiceError("invalid_activation");
      await this.replaceLease(client, activation.activation_id, request);
      await client.query("COMMIT");
      return {
        leaseId: request.leaseId,
        licenseId: activation.license_id,
        issuedAtUnix: Math.floor(request.issuedAt.getTime() / 1_000),
        expiresAtUnix: Math.floor(request.expiresAt.getTime() / 1_000),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async replaceLease(
    client: PoolClient,
    activationId: string,
    request: Pick<ActivateRepositoryRequest, "leaseId" | "issuedAt" | "expiresAt">,
  ): Promise<void> {
    await client.query(
      `UPDATE license_leases
          SET released_at = $2
        WHERE activation_id = $1 AND released_at IS NULL`,
      [activationId, request.issuedAt],
    );
    await client.query(
      `INSERT INTO license_leases
         (lease_id, activation_id, issued_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [request.leaseId, activationId, request.issuedAt, request.expiresAt],
    );
  }
}
