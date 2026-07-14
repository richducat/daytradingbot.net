import { randomUUID } from "node:crypto";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import {
  LicenseServiceError,
  type ActivateRepositoryRequest,
  type DesktopPlatform,
  type LeaseRecord,
  type LicenseRepository,
  type RenewRepositoryRequest,
} from "./licensing.js";

interface LicenseRow extends RowDataPacket {
  license_id: string;
  status: string;
}

interface ActivationRow extends RowDataPacket {
  activation_id: string;
  license_id: string;
  device_public_key: Buffer;
  platform: DesktopPlatform;
}

async function rollbackQuietly(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // Preserve the original transaction failure.
  }
}

export class MySqlLicenseRepository implements LicenseRepository {
  constructor(private readonly pool: Pool) {}

  async activate(request: ActivateRepositoryRequest): Promise<LeaseRecord> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [licenseRows] = await connection.execute<LicenseRow[]>(
        `SELECT license_id, status
           FROM licenses
          WHERE license_secret_hash = ?
          FOR UPDATE`,
        [request.licenseSecretHash],
      );
      const license = licenseRows[0];
      if (!license || license.status !== "active") {
        throw new LicenseServiceError("invalid_license");
      }

      const [activationRows] = await connection.execute<ActivationRow[]>(
        `SELECT activation_id, license_id, device_public_key, platform
           FROM activations
          WHERE license_id = ? AND status = 'active'
          FOR UPDATE`,
        [license.license_id],
      );
      const active = activationRows[0];
      let activationId: string;
      if (active) {
        if (!active.device_public_key.equals(request.devicePublicKey) || active.platform !== request.platform) {
          throw new LicenseServiceError("device_already_active");
        }
        activationId = active.activation_id;
        await connection.execute<ResultSetHeader>(
          `UPDATE activations
              SET activation_secret_hash = ?
            WHERE activation_id = ?`,
          [request.activationSecretHash, activationId],
        );
      } else {
        activationId = randomUUID();
        await connection.execute<ResultSetHeader>(
          `INSERT INTO activations
             (activation_id, license_id, device_public_key, platform, activation_secret_hash)
           VALUES (?, ?, ?, ?, ?)`,
          [
            activationId,
            license.license_id,
            request.devicePublicKey,
            request.platform,
            request.activationSecretHash,
          ],
        );
      }

      await this.replaceLease(connection, activationId, request);
      await connection.commit();
      return {
        leaseId: request.leaseId,
        licenseId: license.license_id,
        issuedAtUnix: Math.floor(request.issuedAt.getTime() / 1_000),
        expiresAtUnix: Math.floor(request.expiresAt.getTime() / 1_000),
      };
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async renew(request: RenewRepositoryRequest): Promise<LeaseRecord> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<ActivationRow[]>(
        `SELECT a.activation_id, a.license_id, a.device_public_key, a.platform
           FROM activations a
           JOIN licenses l ON l.license_id = a.license_id
          WHERE a.activation_secret_hash = ?
            AND a.device_public_key = ?
            AND a.status = 'active'
            AND l.status = 'active'
          FOR UPDATE`,
        [request.activationSecretHash, request.devicePublicKey],
      );
      const activation = rows[0];
      if (!activation) throw new LicenseServiceError("invalid_activation");
      await this.replaceLease(connection, activation.activation_id, request);
      await connection.commit();
      return {
        leaseId: request.leaseId,
        licenseId: activation.license_id,
        issuedAtUnix: Math.floor(request.issuedAt.getTime() / 1_000),
        expiresAtUnix: Math.floor(request.expiresAt.getTime() / 1_000),
      };
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  private async replaceLease(
    connection: PoolConnection,
    activationId: string,
    request: Pick<ActivateRepositoryRequest, "leaseId" | "issuedAt" | "expiresAt">,
  ): Promise<void> {
    await connection.execute<ResultSetHeader>(
      `UPDATE license_leases
          SET released_at = ?
        WHERE activation_id = ? AND released_at IS NULL`,
      [request.issuedAt, activationId],
    );
    await connection.execute<ResultSetHeader>(
      `INSERT INTO license_leases
         (lease_id, activation_id, issued_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      [request.leaseId, activationId, request.issuedAt, request.expiresAt],
    );
  }
}
