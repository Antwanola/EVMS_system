import { Logger } from '../Utils/logger';
import { DatabaseService } from '../services/database';
import { RedisService } from '../services/redis';
import { ChargePointConnection } from '../types/ocpp_types';

export class ChargePointManager {
  private logger = Logger.getInstance();
  
  constructor(
    private db: DatabaseService,
    private redis: RedisService
  ) {}

  public async registerChargePoint(chargePointId: string, connection: ChargePointConnection): Promise<void> {
    try {
      // Update database status
      await this.db.updateChargePointStatus(chargePointId, true);
      
      // Store connection info in Redis for real-time access
      await this.redis.set(
        `connection:${chargePointId}`,
        JSON.stringify({
          id: chargePointId,
          connectedAt: new Date(),
          isAlive: connection.isAlive,
          lastSeen: connection.lastSeen,
        }),
        3600 // 1 hour TTL
      );

      this.logger.info(`Charge point ${chargePointId} registered successfully`);
    } catch (error) {
      this.logger.error(`Error registering charge point ${chargePointId}:`, error);
    }
  }

  public async unregisterChargePoint(chargePointId: string): Promise<void> {
    try {
      // Update database status
      await this.db.updateChargePointStatus(chargePointId, false);
      
      // Remove connection info from Redis
      await this.redis.del(`connection:${chargePointId}`);
      
      this.logger.info(`Charge point ${chargePointId} unregistered successfully`);
    } catch (error) {
      this.logger.error(`Error unregistering charge point ${chargePointId}:`, error);
    }
  }

  public async getChargePointConnectionStatus(chargePointId: string): Promise<any | null> {
    try {
      const connectionData = await this.redis.get(`connection:${chargePointId}`);
      return connectionData ? JSON.parse(connectionData) : null;
    } catch (error) {
      this.logger.error(`Error getting connection status for ${chargePointId}:`, error);
      return null;
    }
  }
}