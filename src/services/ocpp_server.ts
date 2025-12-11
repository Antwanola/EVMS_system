// src/services/ocpp-server.ts
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http'
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
  ChargingStationData,
  ConfigRequestValues,
  ConnectorNumResponse
} from '../types/ocpp_types';
import { APIGateway } from './api_gateway';
import { ChargePointStatus } from '../types/ocpp_types';



export class OCPPServer {
  private logger = Logger.getInstance();
  private connections = new Map<string, ChargePointConnection>();
  private messageHandler: OCPPMessageHandler;
  private chargePointManager: ChargePointManager;
  private chargePointID: string;

  constructor(
    private wss: WebSocketServer,
    private db: DatabaseService,
    private redis: RedisService,
    private apiGateway: APIGateway
  ) {
    this.messageHandler = new OCPPMessageHandler(this.db, this.redis, apiGateway);
    this.chargePointManager = new ChargePointManager(this.db, this.redis);
    this.chargePointID = '';
  }

  public initialize(): void {
    this.wss.on('connection', this.handleConnection.bind(this));
    this.setupHeartbeatCheck();
    this.logger.info('OCPP Server initialized');
  }

  private async handleConnection(ws: WebSocket, request: any): Promise<void> {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    this.chargePointID = pathSegments[pathSegments.length - 1];
    console.log(this.chargePointID)
    console.log({ pathSegments })

    if (!this.chargePointID) {
      this.logger.warn('Connection rejected: No charge point ID provided');
      ws.close(1008, 'Charge point ID required');
      return;
    }

    // Get existing structured data from Redis/memory
    const structuredData = await this.getAllChargeStationsStructured();
    const existingStation = structuredData.chargeStations[this.chargePointID];
    
    const numOfConnector = await this.getConnectorNum();
    const connectors = new Map<number, ChargingStationData>();
    
    const connection: ChargePointConnection = {
      id: this.chargePointID,
      ws,
      isAlive: true,
      lastSeen: new Date(),
      bootNotificationSent: false,
      heartbeatInterval: 300000,
      connectors,
      numberOfConnectors: numOfConnector?.connectorNum || 2,
      meters: new Map<string, any>()
    };

    // Initialize connectors - use existing data if available, otherwise create defaults
    for (let i = 1; i <= (numOfConnector?.connectorNum || 2); i++) {
      const existingConnectorData = existingStation?.connectors[i];
      
      if (existingConnectorData) {
        // Use existing connector data from structured data
        this.logger.info(`Loading existing data for ${this.chargePointID} connector ${i}`);
        connectors.set(i, {
          ...existingConnectorData,
          timestamp: new Date() // Update timestamp to mark reconnection
        });
      } else {
        // Create new default connector data
        this.logger.info(`Creating new connector ${i} for ${this.chargePointID}`);
        const defaultConnector = this.getDefaultChargingData(this.chargePointID, i);
        connectors.set(i, defaultConnector);
      }
    }

    this.connections.set(this.chargePointID, connection);
    this.logger.info(`Charge point ${this.chargePointID} connected with ${connection.numberOfConnectors} connectors`);

    // Setup WebSocket event handlers
    ws.on('message', (data) => this.handleMessage(this.chargePointID, data));
    ws.on('close', () => this.handleDisconnection(this.chargePointID));
    ws.on('error', (error) => this.handleError(this.chargePointID, error));
    ws.on('pong', () => this.handlePong(this.chargePointID));

    // Register charge point
    this.chargePointManager.registerChargePoint(this.chargePointID, connection);
  }

  public async getConnectorNum(): Promise<ConnectorNumResponse | undefined> {
    try {
      const payload = {
        "key": ["NumberOfConnectors"]
      }
      const queryMacForConnectorNum = await this.sendMessage(this.chargePointID, "GetConfiguration", payload);
      if (!queryMacForConnectorNum.configurationKey) {
        return undefined;
      }

      const connectorNum = queryMacForConnectorNum.data.configurationKey.find(
        (item: ConfigRequestValues) => item.key === "NumberOfConnectors"
      );

      if (connectorNum && typeof(connectorNum.value) === "string") {
        return { connectorNum: parseInt(connectorNum.value, 10) }
      }

    } catch (error: any) {
      this.logger.error(`Error getting connector number: ${error.message}`);
    }
  }

  public async triggerStatusForAll(): Promise<void> {
    const allPromises: Promise<void>[] = [];

    this.connections.forEach((chargeStation) => {
      const connectorIds = Array.from(chargeStation.connectors.keys());

      connectorIds.forEach((connectorId) => {
        const p = this.sendTriggerMessage(chargeStation, connectorId, 'StatusNotification')
          .then((res) => {
            console.log(`✅ ${chargeStation.id} connector ${connectorId} responded`, res);
          })
          .catch((err) => {
            console.error(`❌ Error for ${chargeStation.id} connector ${connectorId}:`, err.message);
          });

        allPromises.push(p);
      });
    });

    await Promise.allSettled(allPromises);
    console.log('All connectors triggered for StatusNotification');
  }

  private sendTriggerMessage(
    connection: ChargePointConnection,
    connectorId: number,
    requestedMessage: 'StatusNotification' | 'MeterValues' | 'Heartbeat' | 'BootNotification' | 'FirmwareStatusNotification'
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const uniqueId = uuidv4();
      const message = [MessageType.CALL, uniqueId, 'TriggerMessage', {
        requestedMessage,
        connectorId
      }];

      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for response from ${connection.id} connector ${connectorId}`));
      }, 30000);

      this.messageHandler.addPendingCall(uniqueId, resolve, reject, timeout);
      connection.ws.send(JSON.stringify(message));
    });
  }

  private async handleMessage(chargePointId: string, data: any): Promise<void> {
    try {
      const connection = this.connections.get(chargePointId);
      if (!connection) return;
      connection.lastSeen = new Date();
      connection.isAlive = true;

      const message = JSON.parse(data.toString());
      

      const response = await this.messageHandler.handleMessage(chargePointId, message, connection);
      if (response) {
        connection.ws.send(JSON.stringify(response));
        this.logger.debug(`Sent response to ${chargePointId}:`, response);
      }

      // Update real-time data in Redis
      await this.updateRealTimeData(chargePointId, message, connection);

    } catch (error) {
      this.logger.error(`Error handling message from ${chargePointId}:`, error);
      this.sendCallError(chargePointId, '', 'InternalError', 'Message processing failed');
    }
  }

 private async updateRealTimeData(
  chargePointId: string,
  message: any,
  connection: ChargePointConnection
): Promise<void> {
  try {
    const [messageTypeId, uniqueId, action, payload] = message;

    switch (action) {
      case 'BootNotification':
        // Store boot notification info in Redis
        await this.redis.setJSON(
          `chargepoint:${chargePointId}:info`,
          {
            chargePointModel: payload.chargePointModel,
            chargePointVendor: payload.chargePointVendor,
            chargePointSerialNumber: payload.chargePointSerialNumber,
            firmwareVersion: payload.firmwareVersion,
            lastBootNotification: new Date(),
          },
          86400
        );

        // Update all connectors' timestamps
        connection.connectors.forEach((connectorData) => {
          connectorData.timestamp = new Date();
        });

        this.logger.info(`Boot notification processed for ${chargePointId}`);
        break;

      case 'StatusNotification':
        const connectorId = payload.connectorId || 0;

        // Initialize connector if it doesn't exist
        if (!connection.connectors.has(connectorId)) {
          connection.connectors.set(
            connectorId,
            this.getDefaultChargingData(chargePointId, connectorId)
          );
          this.logger.info(`Discovered new connector ${connectorId} for ${chargePointId}`);
        }

        // Update the specific connector's status in memory
        const connectorData = connection.connectors.get(connectorId)!;
        connectorData.status = payload.status;
        connectorData.timestamp = new Date();
        connection.connectors.set(connectorId, connectorData);

        // Update status in database to keep it in sync
        try {
          await this.db.updateConnectorStatus(
            chargePointId,
            connectorId,
            payload.status,
            payload.errorCode,
            payload.vendorErrorCode
          );
          this.logger.debug(`Database updated for ${chargePointId} connector ${connectorId}: ${payload.status}`);
        } catch (dbError) {
          this.logger.error(`Failed to update database for connector ${connectorId}:`, dbError);
          // Continue execution - memory update succeeded even if DB update failed
        }

        this.logger.debug(`Status updated for ${chargePointId} connector ${connectorId}: ${payload.status}`);
        break;

      case 'MeterValues':
        this.processMeterValues(connection, payload);
        
        // Update timestamp for the specific connector
        const meterConnectorId = payload.connectorId || 1;
        if (connection.connectors.has(meterConnectorId)) {
          const meterConnectorData = connection.connectors.get(meterConnectorId)!;
          meterConnectorData.timestamp = new Date();
          connection.connectors.set(meterConnectorId, meterConnectorData);

          // Optionally update meter values in database
          try {
            // Update the connector's last meter reading timestamp in DB
            await this.db.updateConnectorStatus(
              chargePointId,
              meterConnectorId,
              meterConnectorData.status
            );
          } catch (dbError) {
            this.logger.error(`Failed to update database meter timestamp for connector ${meterConnectorId}:`, dbError);
          }
        }
        
        this.logger.debug(`Meter values processed for ${chargePointId}`);
        break;

      case 'Heartbeat':
        // Update all connectors' timestamps on heartbeat
        connection.connectors.forEach(async (connectorData, id) => {
          connectorData.timestamp = new Date();
          connection.connectors.set(id, connectorData);

          // Optionally sync heartbeat timestamp to database
          try {
            await this.db.updateConnectorStatus(
              chargePointId,
              id,
              connectorData.status
            );
          } catch (dbError) {
            this.logger.error(`Failed to update database heartbeat for connector ${id}:`, dbError);
          }
        });
        this.logger.debug(`Heartbeat received from ${chargePointId}`);
        break;

      case 'StartTransaction':
        // Update connector status when transaction starts
        const startConnectorId = payload.connectorId || 1;
        if (connection.connectors.has(startConnectorId)) {
          const startConnectorData = connection.connectors.get(startConnectorId)!;
          startConnectorData.status = 'Charging' as any;
          startConnectorData.connected = true;
          startConnectorData.timestamp = new Date();
          connection.connectors.set(startConnectorId, startConnectorData);

          // Update database
          try {
            await this.db.updateConnectorStatus(
              chargePointId,
              startConnectorId,
              'CHARGING'
            );
            this.logger.debug(`Database updated for transaction start on connector ${startConnectorId}`);
          } catch (dbError) {
            this.logger.error(`Failed to update database for transaction start:`, dbError);
          }
        }
        break;

      case 'StopTransaction':
        // Update connector status when transaction stops
        const stopConnectorId = payload.connectorId || 1;
        if (connection.connectors.has(stopConnectorId)) {
          const stopConnectorData = connection.connectors.get(stopConnectorId)!;
          stopConnectorData.status = 'Available' as any;
          stopConnectorData.connected = false;
          stopConnectorData.stopReason = payload.reason || null;
          stopConnectorData.timestamp = new Date();
          connection.connectors.set(stopConnectorId, stopConnectorData);

          // Update database
          try {
            await this.db.updateConnectorStatus(
              chargePointId,
              stopConnectorId,
              'AVAILABLE'
            );
            this.logger.debug(`Database updated for transaction stop on connector ${stopConnectorId}`);
          } catch (dbError) {
            this.logger.error(`Failed to update database for transaction stop:`, dbError);
          }
        }
        break;

      default:
        this.logger.debug(`Message ${action} received from ${chargePointId}`);
    }

    // Store all connectors data in Redis
    if (connection.connectors.size > 0) {
      const connectorsArray = Array.from(connection.connectors.values());

      await this.redis.setJSON(
        `chargepoint:${chargePointId}:connectors`,
        connectorsArray,
        3600
      );

      // Batch update all connector statuses to database periodically
      // This ensures DB is in sync with real-time state
      try {
        for (const connector of connectorsArray) {
          await this.db.updateConnectorStatus(
            chargePointId,
            connector.connectorId,
            connector.status
          );
        }
        this.logger.debug(`Batch database sync completed for ${chargePointId}`);
      } catch (dbError) {
        this.logger.error(`Failed to batch sync connectors to database:`, dbError);
      }
    }

    this.logger.debug(`Real-time data updated for ${chargePointId} (${action})`);

  } catch (error) {
    this.logger.error(`Error updating real-time data for ${chargePointId}:`, error);
  }
}

  public async getAllChargeStationsStructured(): Promise<{
    chargeStations: Record<string, { connectors: Record<number, ChargingStationData> }>;
  }> {
    const structuredData: {
      chargeStations: Record<string, { connectors: Record<number, ChargingStationData> }>;
    } = { chargeStations: {} };

    this.connections.forEach((connection, stationId) => {
      const stationData: { connectors: Record<number, ChargingStationData> } = { connectors: {} };
      connection.connectors.forEach((connectorData, connectorId) => {
        stationData.connectors[connectorId] = { ...connectorData };
      });
      structuredData.chargeStations[stationId] = stationData;
    });

    // Store in Redis with TTL
    await this.redis.set('chargeStations:all', JSON.stringify(structuredData), 30);

    return structuredData;
  }

  public async sendChangeConfiguration(
    chargePointId: string,
    key: string,
    value: string,
    clients: Map<string, WebSocket>
  ): Promise<string> {
    const client = clients.get(chargePointId);

    if (!client || client.readyState !== client.OPEN) {
      throw new Error(`Charge point ${chargePointId} is not connected`);
    }

    const messageId = uuidv4();

    const ocppMessage = [
      2,
      messageId,
      "ChangeConfiguration",
      {
        key,
        value
      }
    ];

    try {
      client.send(JSON.stringify(ocppMessage));
      console.log(
        `✅ Sent ChangeConfiguration to ${chargePointId} → ${key}=${value}`
      );
    } catch (error) {
      console.error(
        `❌ Failed to send ChangeConfiguration to ${chargePointId}:`,
        error
      );
      throw error;
    }

    return messageId;
  }

  private processMeterValues(connection: ChargePointConnection, payload: any): void {
    if (!payload.meterValue || !Array.isArray(payload.meterValue)) return;

    const connectorId = payload.connectorId || 1;
    
    // Ensure connector exists
    if (!connection.connectors.has(connectorId)) {
      connection.connectors.set(
        connectorId,
        this.getDefaultChargingData(connection.id, connectorId)
      );
    }

    const connectorData = connection.connectors.get(connectorId)!;

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
    connection.connectors.set(connectorId, connectorData);
  }

  public async getChargeStationGunDetails(
    chargePointId: string
  ): Promise<{
    success: boolean;
    connectors: ChargingStationData[];
    metadata: {
      totalConnectors: number;
      discoveryMethod: string;
      configuredCount?: number;
      discoveredCount: number;
      lastUpdated: Date;
      configResponse: any;
      errors?: string[];
    };
  } | null> {
    const connection = this.connections.get(chargePointId);
    let configResponse
    if (!connection) {
      this.logger.warn(`Charge point ${chargePointId} not connected`);
      return null;
    }

    const errors: string[] = [];
    let discoveryMethod = "unknown";
    let configuredCount: number | undefined;

    try {
      this.logger.info(
        `Starting intelligent connector discovery for ${chargePointId}`
      );

      // Step 1: Try to get NumberOfConnectors from configuration
      try {
        configResponse = await this.sendMessage(chargePointId, "GetConfiguration", {
          key: ["NumberOfConnectors"],
        });
        
        if (configResponse?.configurationKey) {
          const connectorConfig = configResponse.configurationKey.find(
            (config: { key: string; value?: string }) => config.key === "NumberOfConnectors"
          );

          if (connectorConfig?.value) {
            configuredCount = parseInt(connectorConfig.value, 10);
            connection.numberOfConnectors = configuredCount;
            discoveryMethod = "GetConfiguration";

            this.logger.info(
              `Found ${configuredCount} connectors via GetConfiguration for ${chargePointId}`
            );

            // Initialize connectors if not already present
            for (let i = 1; i <= configuredCount; i++) {
              if (!connection.connectors.has(i)) {
                connection.connectors.set(i, this.getDefaultChargingData(chargePointId, i));
              }
            }
          }
        }
      } catch (error: any) {
        errors.push(`GetConfiguration failed: ${error?.message ?? error}`);
        this.logger.debug(`GetConfiguration failed for ${chargePointId}: ${error}`);
      }

      // Step 2: Trigger StatusNotification for all connectors
      try {
        await this.sendMessage(chargePointId, "TriggerMessage", {
          requestedMessage: "StatusNotification",
        });

        this.logger.debug(`Triggered StatusNotification for all connectors on ${chargePointId}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error: any) {
        errors.push(`TriggerMessage (all) failed: ${error?.message ?? error}`);
        this.logger.debug(`TriggerMessage for all connectors failed: ${error}`);
      }

      // Step 3: If we know connector count, trigger each individually
      if (configuredCount) {
        const triggerPromises = [];

        for (let i = 1; i <= configuredCount; i++) {
          triggerPromises.push(
            this.sendMessage(chargePointId, "TriggerMessage", {
              requestedMessage: "StatusNotification",
              connectorId: i,
            }).catch((error: any) => {
              errors.push(`TriggerMessage connector ${i} failed: ${error?.message ?? error}`);
              this.logger.debug(`TriggerMessage for connector ${i} failed: ${error}`);
            })
          );
        }

        await Promise.allSettled(triggerPromises);
        this.logger.debug(`Triggered individual StatusNotifications for ${chargePointId}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      // Step 4: Try to get MeterValues
      try {
        if (connection.connectors.size > 0) {
          const meterPromises = [];

          for (const connectorId of connection.connectors.keys()) {
            meterPromises.push(
              this.sendMessage(chargePointId, "TriggerMessage", {
                requestedMessage: "MeterValues",
                connectorId,
              }).catch((error: any) => {
                this.logger.debug(
                  `TriggerMessage MeterValues for connector ${connectorId} failed: ${error}`
                );
              })
            );
          }

          await Promise.allSettled(meterPromises);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      } catch (error: any) {
        this.logger.debug(`MeterValues trigger failed: ${error}`);
      }

      // Step 5: Compile results
      const finalConnectors = Array.from(connection.connectors.values());
      const finalCount = finalConnectors.length;

      if (finalCount > 0 && discoveryMethod === "unknown") {
        discoveryMethod = "passive_monitoring";
      }

      if (configuredCount && finalCount !== configuredCount) {
        errors.push(
          `Connector count mismatch: configured=${configuredCount}, discovered=${finalCount}`
        );
      }

      this.logger.info(
        `Connector discovery complete for ${chargePointId}: ${finalCount} connectors found`
      );

      return {
        success: finalCount > 0,
        connectors: finalConnectors,
        metadata: {
          totalConnectors: finalCount,
          discoveryMethod,
          configuredCount,
          configResponse,
          discoveredCount: finalCount,
          lastUpdated: new Date(),
          errors: errors.length > 0 ? errors : undefined,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `Error in intelligent connector discovery for ${chargePointId}:`,
        error
      );

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

  // private handleDisconnection(chargePointId: string): void {
  //   this.connections.delete(chargePointId);
  //   this.chargePointManager.unregisterChargePoint(chargePointId);
  //   this.logger.info(`Charge point ${chargePointId} disconnected`);
  // }

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
    }, 30000);
  }

  public sendCallError(chargePointId: string, uniqueId: string, errorCode: string, errorDescription: string): void {
    const connection = this.connections.get(chargePointId);
    if (!connection) return;

    const errorMessage = [MessageType.CALLERROR, uniqueId, errorCode, errorDescription, {}];
    connection.ws.send(JSON.stringify(errorMessage));
  }

  public sendMessage(chargePointId: string, action: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const connection = this.connections.get(chargePointId);
      if (!connection) {
        reject(new Error(`Charge point ${chargePointId} not connected`));
        return;
      }

      const uniqueId = uuidv4();
      const message = [MessageType.CALL, uniqueId, action, payload];

      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for response from ${chargePointId}`));
      }, 30000);

      this.messageHandler.addPendingCall(uniqueId, resolve, reject, timeout);
      connection.ws.send(JSON.stringify(message));
    });
  }

  public getConnectedChargePoints(): string[] {
    return Array.from(this.connections.keys());
  }

  public getChargePointData(chargePointId: string): ChargingStationData[] | null {
    const connection = this.connections.get(chargePointId);
    return connection ? Array.from(connection.connectors.values()) : null;
  }

  public getAllChargePointsData(): Map<string, ChargingStationData[]> {
    const data = new Map<string, ChargingStationData[]>();
    this.connections.forEach((connection, id) => {
      data.set(id, Array.from(connection.connectors.values()));
    });
    return data;
  }

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
      connectors: connectors,
      metadata: {
        isConnected: true,
        totalDiscovered: connectors.length,
        connectorIds: connectorIds,
        lastSeen: connection.lastSeen
      }
    };
  }

  public getChargePointConnector(chargePointId: string, connectorId: number): ChargingStationData | null {
    const connection = this.connections.get(chargePointId);
    if (!connection) return null;

    return connection.connectors.get(connectorId) || null;
  }

  public getConnectorCount(chargePointId: string): number {
    const connection = this.connections.get(chargePointId);
    if (!connection) return 0;

    return connection.connectors.size;
  }

  public getAllChargePointsConnectorData(): Map<string, ChargingStationData[]> {
    const data = new Map<string, ChargingStationData[]>();
    this.connections.forEach((connection, id) => {
      const connectors = Array.from(connection.connectors.values());
      data.set(id, connectors);
    });
    return data;
  }


  private async handleDisconnection(chargePointId: string): Promise<void> {
    const connection = this.connections.get(chargePointId);
    
    if (connection) {
      // Set all connectors to offline in database
      try {
        const connectorIds = Array.from(connection.connectors.keys());
        for (const connectorId of connectorIds) {
          await this.db.updateConnectorStatus(
            chargePointId,
            connectorId,
            "UNAVAILABLE"
            
          );
          this.logger.debug(`Set connector ${connectorId} to OFFLINE for ${chargePointId}`);
        }
        this.logger.info(`All connectors set to OFFLINE for ${chargePointId}`);
      } catch (error) {
        this.logger.error(`Failed to set connectors offline for ${chargePointId}:`, error);
      }
      
      // Update Redis to mark as offline
      try {
        await this.redis.setJSON(
          `chargepoint:${chargePointId}:status`,
          { status: 'unavailable', disconnectedAt: new Date() },
          3600
        );
      } catch (error) {
        this.logger.error(`Failed to update Redis status for ${chargePointId}:`, error);
      }
    }
    
    this.connections.delete(chargePointId);
    this.chargePointManager.unregisterChargePoint(chargePointId);
    this.logger.info(`Charge point ${chargePointId} disconnected`);
  }
}