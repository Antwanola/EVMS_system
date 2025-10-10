// src/services/ocpp-server.ts
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../Utils/logger';
import { OCPPMessageHandler } from '../handlers/ocpp_handlers';
import { ChargePointManager } from '../services/charge-point-manager';
import { DatabaseService } from '../services/database';
import { RedisService } from '../services/redis';
import { 
  ChargePointConnection, 
  OCPPMessage, 
  MessageType,
  ChargingStationData 
} from '../types/ocpp_types';

type TriggerMessageType = 'StatusNotification' | 'MeterValues' | 'Heartbeat' | 'BootNotification' | 'FirmwareStatusNotification' | 'DiagnosticsStatusNotification';

interface SendMessageOptions {
  timeout?: number;
  logResponse?: boolean;
}

interface ConnectorDiscoveryResult {
  success: boolean;
  connectors: ChargingStationData[];
  metadata: {
    totalConnectors: number;
    discoveryMethod: string;
    configuredCount?: number;
    discoveredCount: number;
    lastUpdated: Date;
    configResponse?: any;
    errors?: string[];
  };
}

export class OCPPServer {
  private readonly logger = Logger.getInstance();
  private readonly connections = new Map<string, ChargePointConnection>();
  private readonly messageHandler: OCPPMessageHandler;
  private readonly chargePointManager: ChargePointManager;
  
  private readonly DEFAULT_TIMEOUT = 30000;
  private readonly HEARTBEAT_CHECK_INTERVAL = 30000;
  private readonly REDIS_TTL = 3600;

  constructor(
    private readonly wss: WebSocketServer,
    private readonly db: DatabaseService,
    private readonly redis: RedisService
  ) {
    this.messageHandler = new OCPPMessageHandler(this.db, this.redis);
    this.chargePointManager = new ChargePointManager(this.db, this.redis);
  }

  public initialize(): void {
    this.wss.on('connection', this.handleConnection.bind(this));
    this.setupHeartbeatCheck();
    this.logger.info('OCPP Server initialized');
  }

  // ==================== CONNECTION MANAGEMENT ====================

  private handleConnection(ws: WebSocket, request: any): void {
    const chargePointId = this.extractChargePointId(request);
    
    if (!chargePointId) {
      this.logger.warn('Connection rejected: No charge point ID provided');
      ws.close(1008, 'Charge point ID required');
      return;
    }

    const connection = this.createConnection(chargePointId, ws);
    this.connections.set(chargePointId, connection);
    
    this.logger.info(`Charge point ${chargePointId} connected with ${connection.numberOfConnectors} connectors`);

    this.setupWebSocketHandlers(ws, chargePointId);
    this.chargePointManager.registerChargePoint(chargePointId, connection);
  }

  private extractChargePointId(request: any): string | null {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    return pathSegments[pathSegments.length - 1] || null;
  }

  private createConnection(chargePointId: string, ws: WebSocket): ChargePointConnection {
    const connectors = new Map<number, ChargingStationData>();
    
    return {
      id: chargePointId,
      ws,
      isAlive: true,
      lastSeen: new Date(),
      bootNotificationSent: false,
      heartbeatInterval: 300000,
      currentData: null,
      connectors,
      numberOfConnectors: connectors.size,
      meters: new Map<string, any>()
    };
  }

  private setupWebSocketHandlers(ws: WebSocket, chargePointId: string): void {
    ws.on('message', (data) => this.handleMessage(chargePointId, data));
    ws.on('close', () => this.handleDisconnection(chargePointId));
    ws.on('error', (error) => this.handleError(chargePointId, error));
    ws.on('pong', () => this.handlePong(chargePointId));
  }

  private async handleDisconnection(chargePointId: string): Promise<void> {
    const connection = this.connections.get(chargePointId);

  if (connection) {
    await this.setAllConnectorsOffline(chargePointId, connection);
    this.connections.delete(chargePointId);
    this.chargePointManager.unregisterChargePoint(chargePointId);
    this.logger.info(`Charge point ${chargePointId} disconnected`);
  }
}

  private handleError(chargePointId: string, error: Error): void {
    this.logger.error(`WebSocket error for ${chargePointId}:`, error);
  }

  private handlePong(chargePointId: string): void {
    const connection = this.connections.get(chargePointId);
    if (connection) {
      connection.isAlive = true;
      connection.lastSeen = new Date();
    }
  }

  private setupHeartbeatCheck(): void {
    setInterval(() => {
      this.connections.forEach((connection, chargePointId) => {
        if (!connection.isAlive) {
          this.logger.warn(`Terminating dead connection: ${chargePointId}`);
          connection.ws.terminate();
          this.connections.delete(chargePointId);
          return;
        }

        connection.isAlive = false;
        connection.ws.ping();
      });
    }, this.HEARTBEAT_CHECK_INTERVAL);
  }

  // ==================== MESSAGE HANDLING ====================

  private async handleMessage(chargePointId: string, data: any): Promise<void> {
    try {
      const connection = this.connections.get(chargePointId);
      if (!connection) return;

      this.updateConnectionStatus(connection);

      const message: OCPPMessage = JSON.parse(data.toString());
      this.logger.debug(`Received message from ${chargePointId}:`, message);

      const response = await this.messageHandler.handleMessage(chargePointId, message, connection);
      
      if (response) {
        connection.ws.send(JSON.stringify(response));
        this.logger.debug(`Sent response to ${chargePointId}:`, response);
      }

      await this.updateRealTimeData(chargePointId, message, connection);

    } catch (error) {
      this.logger.error(`Error handling message from ${chargePointId}:`, error);
      this.sendCallError(chargePointId, '', 'InternalError', 'Message processing failed');
    }
  }

  private updateConnectionStatus(connection: ChargePointConnection): void {
    connection.lastSeen = new Date();
    connection.isAlive = true;
  }

  public sendCallError(
    chargePointId: string, 
    uniqueId: string, 
    errorCode: string, 
    errorDescription: string
  ): void {
    const connection = this.connections.get(chargePointId);
    if (!connection) return;

    const errorMessage = [MessageType.CALLERROR, uniqueId, errorCode, errorDescription, {}];
    connection.ws.send(JSON.stringify(errorMessage));
  }

  // ==================== SEND MESSAGE API ====================

  public sendMessage(
    chargePointId: string, 
    action: string, 
    payload: any,
    options?: SendMessageOptions
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const connection = this.connections.get(chargePointId);
      if (!connection) {
        reject(new Error(`Charge point ${chargePointId} not connected`));
        return;
      }

      const uniqueId = uuidv4();
      const message = [MessageType.CALL, uniqueId, action, payload];
      
      const timeoutDuration = options?.timeout || this.DEFAULT_TIMEOUT;
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for response from ${chargePointId} for action ${action}`));
      }, timeoutDuration);

      this.messageHandler.addPendingCall(uniqueId, resolve, reject, timeout);
      
      try {
        connection.ws.send(JSON.stringify(message));
        this.logger.debug(`Sent ${action} to ${chargePointId}`, payload);
      } catch (error) {
        clearTimeout(timeout);
        reject(new Error(`Failed to send message to ${chargePointId}: ${error}`));
      }
    });
  }

  // ==================== TRIGGER MESSAGE API ====================

  public async triggerMessage(
    chargePointId: string,
    requestedMessage: TriggerMessageType,
    connectorId?: number
  ): Promise<any> {
    const payload: any = { requestedMessage };
    if (connectorId !== undefined) {
      payload.connectorId = connectorId;
    }

    return this.sendMessage(chargePointId, 'TriggerMessage', payload);
  }

  public async getMeterValues(chargePointId: string, connectorId: number): Promise<any> {
    return this.triggerMessage(chargePointId, 'MeterValues', connectorId);
  }

  public async getStatusNotification(chargePointId: string, connectorId?: number): Promise<any> {
    return this.triggerMessage(chargePointId, 'StatusNotification', connectorId);
  }

  public async triggerHeartbeat(chargePointId: string): Promise<any> {
    return this.triggerMessage(chargePointId, 'Heartbeat');
  }

  public async triggerStatusForAll(): Promise<void> {
    const allPromises: Promise<void>[] = [];

    this.connections.forEach((connection) => {
      const connectorIds = Array.from(connection.connectors.keys());

      connectorIds.forEach((connectorId) => {
        const promise = this.triggerMessage(connection.id, 'StatusNotification', connectorId)
          .then((res) => {
            this.logger.debug(`✅ ${connection.id} connector ${connectorId} responded`, res);
          })
          .catch((err) => {
            this.logger.error(`❌ Error for ${connection.id} connector ${connectorId}:`, err.message);
          });

        allPromises.push(promise);
      });
    });

    await Promise.allSettled(allPromises);
    this.logger.info('All connectors triggered for StatusNotification');
  }

  // ==================== CONFIGURATION API ====================

  public async getConfiguration(chargePointId: string, keys?: string[]): Promise<any> {
    const payload: any = {};
    if (keys && keys.length > 0) {
      payload.key = keys;
    }
    return this.sendMessage(chargePointId, 'GetConfiguration', payload);
  }

  public async changeConfiguration(
    chargePointId: string,
    key: string,
    value: string
  ): Promise<any> {
    return this.sendMessage(chargePointId, 'ChangeConfiguration', { key, value });
  }

  // ==================== TRANSACTION API ====================

  public async remoteStartTransaction(
    chargePointId: string,
    connectorId: number,
    idTag: string,
    chargingProfile?: any
  ): Promise<any> {
    const payload: any = { connectorId, idTag };
    if (chargingProfile) {
      payload.chargingProfile = chargingProfile;
    }
    return this.sendMessage(chargePointId, 'RemoteStartTransaction', payload);
  }

  public async remoteStopTransaction(chargePointId: string, transactionId: number): Promise<any> {
    return this.sendMessage(chargePointId, 'RemoteStopTransaction', { transactionId });
  }

  // ==================== CONTROL API ====================

  public async resetChargePoint(chargePointId: string, type: 'Hard' | 'Soft'): Promise<any> {
    return this.sendMessage(chargePointId, 'Reset', { type });
  }

  public async unlockConnector(chargePointId: string, connectorId: number): Promise<any> {
    return this.sendMessage(chargePointId, 'UnlockConnector', { connectorId });
  }

  // ==================== REAL-TIME DATA PROCESSING ====================

  private async updateRealTimeData(
    chargePointId: string, 
    message: OCPPMessage, 
    connection: ChargePointConnection
  ): Promise<void> {
    try {
      const connectorId = message.payload?.connectorId || 1;

      // Ensure connector exists
      // if (!connection.connectors.has(connectorId)) {
      //   connection.connectors.set(connectorId, this.getDefaultChargingData(chargePointId, connectorId));
      //   this.logger.info(`Discovered new connector ${connectorId} for ${chargePointId}`);
      // }

      const connectorData = connection.connectors.get(connectorId)!;

      // Update based on message type
      switch (message.action) {
        case 'StatusNotification':
          connectorData.status = message.payload.status;
          connectorData.timestamp = new Date();
          break;
        
        case 'MeterValues':
          this.processMeterValues(connectorData, message.payload);
          break;

        case 'StartTransaction':
          connectorData.connected = true;
          connectorData.timestamp = new Date();
          break;

        case 'StopTransaction':
          connectorData.connected = false;
          connectorData.timestamp = new Date();
          break;
      }

      connection.connectors.set(connectorId, connectorData);
      connection.currentData = connectorData;

      // Store in Redis and database
      await this.persistConnectorData(chargePointId, connection);

    } catch (error) {
      this.logger.error(`Error updating real-time data for ${chargePointId}:`, error);
    }
  }

  private async persistConnectorData(
    chargePointId: string, 
    connection: ChargePointConnection
  ): Promise<void> {
    const connectorsData = Array.from(connection.connectors.entries());

    // Store in Redis
    await this.redis.set(
      `chargepoint:${chargePointId}:connectors`,
      JSON.stringify(connectorsData),
      this.REDIS_TTL
    );

    // Store in database
    for (const connectorData of connectorsData) {
      await this.db.saveChargingData(connectorData);
    }
  }

  private processMeterValues(connectorData: ChargingStationData, payload: any): void {
    if (!payload.meterValue || !Array.isArray(payload.meterValue)) return;

    payload.meterValue.forEach((meterValue: any) => {
      if (!meterValue.sampledValue) return;

      meterValue.sampledValue.forEach((sample: any) => {
        const value = parseFloat(sample.value);

        switch (sample.measurand) {
          case 'Voltage':
            if (sample.location === 'Inlet') {
              connectorData.inputVoltage = value;
            } else if (sample.location === 'Outlet') {
              connectorData.outputVoltage = value;
            }
            break;
          
          case 'Current.Import':
            if (sample.location === 'Inlet') {
              connectorData.inputCurrent = value;
            } else {
              connectorData.demandCurrent = value;
            }
            break;
          
          case 'Energy.Active.Import.Register':
            connectorData.chargingEnergy = value;
            break;
          
          case 'Power.Active.Import':
            connectorData.outputEnergy = value;
            break;
          
          case 'Temperature':
            connectorData.gunTemperature = value;
            break;
          
          case 'SoC':
            connectorData.stateOfCharge = value;
            break;
        }
      });
    });

    connectorData.timestamp = new Date();
  }

  // ==================== CONNECTOR DISCOVERY ====================

  public async discoverConnectors(chargePointId: string): Promise<ConnectorDiscoveryResult | null> {
    const connection = this.connections.get(chargePointId);
    
    if (!connection) {
      this.logger.warn(`Charge point ${chargePointId} not connected`);
      return null;
    }

    const errors: string[] = [];
    let discoveryMethod = "unknown";
    let configuredCount: number | undefined;
    let configResponse: any;

    try {
      this.logger.info(`Starting connector discovery for ${chargePointId}`);

      // Step 1: Get NumberOfConnectors from configuration
      configuredCount = await this.tryGetConnectorCount(chargePointId, connection, errors);
      if (configuredCount) {
        configResponse = { configuredCount };
        discoveryMethod = "GetConfiguration";
      }

      // Step 2: Trigger StatusNotification for discovery
      await this.triggerConnectorDiscovery(chargePointId, configuredCount, errors);

      // Step 3: Trigger MeterValues
      await this.triggerMeterValues(connection, errors);

      // Step 4: Fallback to probing common IDs
      if (connection.connectors.size === 0 && !configuredCount) {
        await this.probeCommonConnectorIds(chargePointId, errors);
        discoveryMethod = "probe_common_ids";
      }

      // Compile results
      const finalConnectors = Array.from(connection.connectors.values());
      const finalCount = finalConnectors.length;

      if (finalCount > 0 && discoveryMethod === "unknown") {
        discoveryMethod = "passive_monitoring";
      }

      if (configuredCount && finalCount !== configuredCount) {
        errors.push(`Connector count mismatch: configured=${configuredCount}, discovered=${finalCount}`);
      }

      this.logger.info(`Connector discovery complete for ${chargePointId}: ${finalCount} connectors found`);

      return {
        success: finalCount > 0,
        connectors: finalConnectors,
        metadata: {
          totalConnectors: finalCount,
          discoveryMethod,
          configuredCount,
          discoveredCount: finalCount,
          lastUpdated: new Date(),
          configResponse,
          errors: errors.length > 0 ? errors : undefined,
        },
      };

    } catch (error: any) {
      this.logger.error(`Error in connector discovery for ${chargePointId}:`, error);
      
      const fallbackConnectors = Array.from(connection.connectors.values());
      return {
        success: fallbackConnectors.length > 0,
        connectors: fallbackConnectors,
        metadata: {
          totalConnectors: fallbackConnectors.length,
          discoveryMethod: "error_fallback",
          configuredCount,
          discoveredCount: fallbackConnectors.length,
          lastUpdated: new Date(),
          configResponse,
          errors: [...errors, `Discovery error: ${error?.message ?? error}`],
        },
      };
    }
  }

  private async tryGetConnectorCount(
    chargePointId: string, 
    connection: ChargePointConnection, 
    errors: string[]
  ): Promise<number | undefined> {
    try {
      const response = await this.getConfiguration(chargePointId, ['NumberOfConnectors']);
      
      if (response?.configurationKey) {
        const connectorConfig = response.configurationKey.find(
          (config: { key: string; value?: string }) => config.key === "NumberOfConnectors"
        );

        if (connectorConfig?.value) {
          const count = parseInt(connectorConfig.value, 10);
          connection.numberOfConnectors = count;

          for (let i = 1; i <= count; i++) {
            if (!connection.connectors.has(i)) {
              connection.connectors.set(i, this.getDefaultChargingData(chargePointId, i));
            }
          }

          return count;
        }
      }
    } catch (error: any) {
      errors.push(`GetConfiguration failed: ${error?.message ?? error}`);
      this.logger.debug(`GetConfiguration failed for ${chargePointId}: ${error}`);
    }

    return undefined;
  }

  private async triggerConnectorDiscovery(
    chargePointId: string, 
    configuredCount: number | undefined, 
    errors: string[]
  ): Promise<void> {
    try {
      await this.getStatusNotification(chargePointId);
      await this.delay(2000);
    } catch (error: any) {
      errors.push(`TriggerMessage (all) failed: ${error?.message ?? error}`);
    }

    if (configuredCount) {
      const triggerPromises = [];
      for (let i = 1; i <= configuredCount; i++) {
        triggerPromises.push(
          this.getStatusNotification(chargePointId, i).catch((error: any) => {
            errors.push(`TriggerMessage connector ${i} failed: ${error?.message ?? error}`);
          })
        );
      }
      await Promise.allSettled(triggerPromises);
      await this.delay(3000);
    }
  }

  private async triggerMeterValues(connection: ChargePointConnection, errors: string[]): Promise<void> {
    if (connection.connectors.size === 0) return;

    const meterPromises = [];
    for (const connectorId of connection.connectors.keys()) {
      meterPromises.push(
        this.getMeterValues(connection.id, connectorId).catch(() => {})
      );
    }

    await Promise.allSettled(meterPromises);
    await this.delay(1500);
  }

  private async probeCommonConnectorIds(chargePointId: string, errors: string[]): Promise<void> {
    const commonIds = [1, 2, 3, 4];

    for (const id of commonIds) {
      try {
        await this.getStatusNotification(chargePointId, id);
      } catch {
        break;
      }
    }

    await this.delay(2000);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== QUERY API ====================

  public getConnectedChargePoints(): string[] {
    return Array.from(this.connections.keys());
  }

  public getChargePointConnector(chargePointId: string, connectorId: number): ChargingStationData | null {
    const connection = this.connections.get(chargePointId);
    return connection?.connectors.get(connectorId) || null;
  }

  public getAllChargingConnectors(chargePointId: string): ChargingStationData[] | null {
    const connection = this.connections.get(chargePointId);
    return connection ? Array.from(connection.connectors.values()) : null;
  }

  public getConnectorCount(chargePointId: string): number {
    const connection = this.connections.get(chargePointId);
    return connection?.connectors.size || 0;
  }

  public getAllChargePointsConnectorData(): Map<string, ChargingStationData[]> {
    const data = new Map<string, ChargingStationData[]>();
    this.connections.forEach((connection, id) => {
      const connectors = Array.from(connection.connectors.values());
      data.set(id, connectors);
    });
    return data;
  }

  public getChargePointConnectorsDetailed(chargePointId: string): {
    connectors: ChargingStationData[] | null;
    metadata: {
      isConnected: boolean;
      totalDiscovered: number;
      connectorIds: number[];
      lastSeen?: Date;
    };
  } {
    const connection = this.connections.get(chargePointId);
    
    if (!connection) {
      return {
        connectors: null,
        metadata: {
          isConnected: false,
          totalDiscovered: 0,
          connectorIds: []
        }
      };
    }

    const connectors = Array.from(connection.connectors.values());
    const connectorIds = Array.from(connection.connectors.keys()).sort((a, b) => a - b);

    return {
      connectors,
      metadata: {
        isConnected: true,
        totalDiscovered: connectors.length,
        connectorIds,
        lastSeen: connection.lastSeen
      }
    };
  }

  /**
 * Mark all connectors of a charge point as Offline
 */
private async setAllConnectorsOffline(chargePointId: string, connection: ChargePointConnection): Promise<void> {
  connection.connectors.forEach((connectorData, connectorId) => {
    connectorData.status = "Offline" as any;
    connectorData.connected = false;
    connectorData.timestamp = new Date();
    connection.connectors.set(connectorId, connectorData);
  });

  try {
    await this.persistConnectorData(chargePointId, connection);
    this.logger.info(`All connectors for ${chargePointId} set to Offline`);
  } catch (err) {
    this.logger.error(`Failed to persist offline status for ${chargePointId}:`, err);
  }
}


  // ==================== HELPERS ====================

  private getDefaultChargingData(chargePointId: string, connectorId: number): ChargingStationData {
    return {
      chargePointId,
      connectorId,
      gunType: 'TYPE2' as any,
      status: 'Available' as any,
      inputVoltage: 0,
      inputCurrent: 0,
      outputContactors: false,
      outputVoltage: 0,
      outputEnergy: 0,
      chargingEnergy: 0,
      alarm: null,
      stopReason: null,
      connected: false,
      gunTemperature: 25,
      stateOfCharge: 0,
      chargeTime: 0,
      remainingTime: 0,
      demandCurrent: 0,
      timestamp: new Date()
    };
  }
}