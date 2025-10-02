import { Logger } from '../Utils/logger';
import { DatabaseService } from '../services/database';
import { RedisService } from '../services/redis';
import { ChargePointConnection, ChargePointStatus } from '../types/ocpp_types';

export class ChargePointManager {
  private logger = Logger.getInstance();
  
  constructor(
    private db: DatabaseService,
    private redis: RedisService
  ) {}

  /**
   * Register a new charge point connection
   */
  public async registerChargePoint(chargePointId: string, connection: ChargePointConnection): Promise<void> {
    try {
      await this.db.updateChargePointStatus(chargePointId, true);

      const payload = {
        id: chargePointId,
        connectedAt: new Date(),
        isAlive: connection.isAlive,
        lastSeen: connection.lastSeen,
        connectors: {} // initialize connector map
      };

      await this.redis.set(
        `connection:${chargePointId}`,
        JSON.stringify(payload),
        3600
      );

      this.logger.info(`Charge point ${chargePointId} registered successfully`);
    } catch (error) {
      this.logger.error(`Error registering charge point ${chargePointId}:`, error);
    }
  }

  /**
   * Unregister a charge point
   */
  public async unregisterChargePoint(chargePointId: string): Promise<void> {
    try {
      await this.db.updateChargePointStatus(chargePointId, false);
      await this.redis.del(`connection:${chargePointId}`);
      
      this.logger.info(`Charge point ${chargePointId} unregistered successfully`);
    } catch (error) {
      this.logger.error(`Error unregistering charge point ${chargePointId}:`, error);
    }
  }

  /**
   * Get full connection + connector status
   */
  public async getChargePointConnectionStatus(chargePointId: string): Promise<any | null> {
    try {
      const connectionData = await this.redis.get(`connection:${chargePointId}`);
      return connectionData ? JSON.parse(connectionData) : null;
    } catch (error) {
      this.logger.error(`Error getting connection status for ${chargePointId}:`, error);
      return null;
    }
  }

  /**
   * Update a connector’s real-time status (called on StatusNotification)
   */
  public async updateConnectorStatus(
    chargePointId: string,
    connectorId: number,
    status: ChargePointStatus,
    errorCode: string | null = null
  ): Promise<void> {
    try {
      const connectionData = await this.getChargePointConnectionStatus(chargePointId);

      if (!connectionData) {
        this.logger.warn(`Charge point ${chargePointId} not registered, cannot update connector ${connectorId}`);
        return;
      }

      connectionData.connectors[connectorId] = {
        status,
        errorCode,
        updatedAt: new Date()
      };

      // update redis
      await this.redis.set(
        `connection:${chargePointId}`,
        JSON.stringify(connectionData),
        3600
      );

      // optional: persist in DB for history
      await this.db.logConnectorStatus(chargePointId, connectorId, status, errorCode);

      this.logger.info(`Updated connector ${connectorId} of charge point ${chargePointId} to ${status}`);
    } catch (error) {
      this.logger.error(`Error updating connector ${connectorId} of charge point ${chargePointId}:`, error);
    }
  }
}
