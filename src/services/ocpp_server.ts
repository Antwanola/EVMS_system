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
    console.log('Current connections:', Array.from(this.connections.keys()));
    
    this.logger.info(`Charge point ${chargePointId} connected with ${connection.numberOfConnectors} connectors`);

    this.setupWebSocketHandlers(ws, chargePointId);
    this.chargePointManager.registerChargePoint(chargePointId, connection);
  }

  private extractChargePointId(request: any): string | null {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    console.log('Extracted path segments:', pathSegments[pathSegments.length - 1]);
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
      this.connections.delete(chargePointId);
      this.chargePointManager.unregisterChargePoint(chargePointId);
      this.logger.info(`Charge point ${chargePointId} disconnected`);
    }
  }

  private handleError(chargePointId: string, error: Error): void {
    this.logger.error(`WebSocket error for ${chargePointId}:`, error);
  }

  private handlePong(chargePointId: string): ChargePointConnection | null{
    const connection = this.connections.get(chargePointId);
    if (connection) {
      connection.isAlive = true;
      connection.lastSeen = new Date();
      return connection
    }
    return null;
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


  private async updateRealTimeData(
    chargePointId: string, 
    message: OCPPMessage, 
    connection: ChargePointConnection
  ): Promise<void> {
    try {
      const connectorId = message.payload?.connectorId;
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
  // Ensure we have connectors to persist
  if (!connection?.connectors || connection.connectors.size === 0) {
    this.logger.warn(`No connectors found for charge point ${chargePointId}`);
    return;
  }

  const connectorsData = Array.from(connection.connectors.entries());
  this.logger.debug(`Persisting ${connectorsData.length} connectors for ${chargePointId}`);
  console.log(`Persisting connectors for ${chargePointId}:`, connectorsData);
  // Store in Redis
  try {
    await this.redis.set(
      `chargepoint:${chargePointId}:connectors`,
      JSON.stringify(connectorsData),
      this.REDIS_TTL
    );
  } catch (err) {
    this.logger.error(`Failed to store connector data in Redis for ${chargePointId}`, err);
  }

  // Store in database
  for (const [connectorID, connectorData] of connectorsData) {
    if (!connectorData || !connectorData.chargePointId) {
      this.logger.warn(
        `Skipping invalid connector data for ${chargePointId}:${connectorID}`,
        connectorData
      );
      continue;
    }

    try {
      await this.db.saveChargingData(connectorID, connectorData);
    } catch (err) {
      this.logger.error(
        `Database save failed for ${chargePointId}:${connectorID}`,
        err
      );
    }
  }
}


  private processMeterValues(connectorData: ChargingStationData, payload: any): void {
    if (!payload.meterValue || !Array.isArray(payload.meterValue)) return;

    payload.meterValue.forEach((meterValue: any) => {
      if (!meterValue.sampledValue) return;

      meterValue.sampledValue.forEach((sample: any) => {
        switch (sample.measurand) {
          case 'Voltage':
            if (sample.location === 'Inlet') {
              connectorData.inputVoltage = parseFloat(sample.value);
            } else if (sample.location === 'Outlet') {
              connectorData.outputVoltage = parseFloat(sample.value);
            }
            break;
          
          case 'Current.Import':
            if (sample.location === 'Inlet') {
              connectorData.inputCurrent = parseFloat(sample.value);
            } else {
              connectorData.demandCurrent = parseFloat(sample.value);
            }
            break;
          
          case 'Energy.Active.Import.Register':
            connectorData.chargingEnergy = parseFloat(sample.value);
            break;
          
          case 'Power.Active.Import':
            connectorData.outputEnergy = parseFloat(sample.value);
            break;
          
          case 'Temperature':
            connectorData.gunTemperature = parseFloat(sample.value);
            break;
          
          case 'SoC':
            connectorData.stateOfCharge = parseFloat(sample.value);
            break;
        }
      });
    });

    connectorData.timestamp = new Date();
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
 
}