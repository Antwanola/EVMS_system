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

  constructor(
    private wss: WebSocketServer,
    private db: DatabaseService,
    private redis: RedisService,
    private apiGateway: APIGateway
  ) {
    this.messageHandler = new OCPPMessageHandler(this.db, this.redis, apiGateway);
    this.chargePointManager = new ChargePointManager(this.db, this.redis);
  }

  public initialize(): void {
    this.wss.on('connection', this.handleConnection.bind(this));
    this.setupHeartbeatCheck();
    this.logger.info('✅ OCPP Server initialized and listening for connections');
  }

  private async handleConnection(ws: WebSocket, request: any): Promise<void> {
    try {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const pathSegments = url.pathname.split('/').filter(Boolean);
      const chargePointID = pathSegments[pathSegments.length - 1];

      this.logger.info(`🔌 Connection attempt: ${request.url}`);
      console.log(`🔌 Connection attempt from: ${chargePointID}`);

      if (!chargePointID || chargePointID.trim() === '') {
        this.logger.warn('❌ Connection rejected: No charge point ID provided');
        ws.close(1008, 'Charge point ID required');
        return;
      }

      // Check if charge point is already connected
      if (this.connections.has(chargePointID)) {
        this.logger.warn(`⚠️ Charge point ${chargePointID} already connected, replacing connection`);
        const oldConnection = this.connections.get(chargePointID)!;
        oldConnection.ws.close(1000, 'New connection established');
      }

      let numOfConnector: ConnectorNumResponse | undefined;
      
      // Get connector count - use default if fails
      try {
        numOfConnector = await this.getConnectorNum(chargePointID);
      } catch (error) {
        this.logger.warn(`⚠️ Failed to get connector count for ${chargePointID}, using default (2)`);
        numOfConnector = { connectorNum: 2 };
      }

      const connectors = new Map<number, ChargingStationData>();
      
      // Initialize connectors with default data
      for (let i = 1; i <= (numOfConnector?.connectorNum || 2); i++) {
        const defaultConnector = this.getDefaultChargingData(chargePointID, i);
        connectors.set(i, defaultConnector);
        this.logger.debug(`📍 Initialized connector ${i} for ${chargePointID}`);
      }

      const connection: ChargePointConnection = {
        id: chargePointID,
        ws,
        isAlive: true,
        lastSeen: new Date(),
        bootNotificationSent: false,
        heartbeatInterval: 300000,
        connectors,
        numberOfConnectors: numOfConnector?.connectorNum || 1,
        meters: new Map<string, any>()
      };

      this.connections.set(chargePointID, connection);
      this.logger.info(`✅ Charge point ${chargePointID} connected with ${connection.numberOfConnectors} connectors`);
      console.log(`✅ ${chargePointID} is now connected` ,connection.currentData);

      // Setup WebSocket event handlers
      ws.on('message', (data) => {
        this.logger.debug(`📨 Raw message from ${chargePointID}`);
        this.handleMessage(chargePointID, data);
      });

      ws.on('close', () => {
        this.logger.info(`📴 WebSocket closed for ${chargePointID}`);
        this.handleDisconnection(chargePointID);
      });

      ws.on('error', (error) => {
        this.logger.error(`⚠️ WebSocket error for ${chargePointID}: ${error.message}`);
        this.handleError(chargePointID, error);
      });

      ws.on('pong', () => {
        this.handlePong(chargePointID);
      });

      // Register charge point with manager
      this.chargePointManager.registerChargePoint(chargePointID, connection);

    } catch (error: any) {
      this.logger.error(`❌ Error during connection handling: ${error.message}`);
      ws.close(1011, 'Internal server error');
    }
  }

  public async getConnectorNum(chargePointID: string): Promise<ConnectorNumResponse | undefined> {
    try {
      const payload = {
        "key": ["NumberOfConnectors"]
      };
      
      const queryMacForConnectorNum = await this.sendMessage(chargePointID, "GetConfiguration", payload);
      
      if (!queryMacForConnectorNum?.configurationKey) {
        return undefined;
      }

      const connectorNum = queryMacForConnectorNum.configurationKey.find(
        (item: ConfigRequestValues) => item.key === "NumberOfConnectors"
      );

      if (connectorNum && typeof(connectorNum.value) === "string") {
        const parsedNum = parseInt(connectorNum.value, 10);
        this.logger.info(`📊 Retrieved connector count: ${parsedNum}`);
        return { connectorNum: parsedNum };
      }

    } catch (error: any) {
      this.logger.error(`❌ Error getting connector number: ${error.message}`);
      throw error;
    }
  }

  public async triggerStatusForAll(): Promise<void> {
    const allPromises: Promise<void>[] = [];

    this.connections.forEach((chargeStation) => {
      const connectorIds = Array.from(chargeStation.connectors.keys());

      connectorIds.forEach((connectorId) => {
        const p = this.sendTriggerMessage(chargeStation, connectorId, 'StatusNotification')
          .then((res) => {
            this.logger.info(`✅ ${chargeStation.id} connector ${connectorId} responded`);
          })
          .catch((err) => {
            this.logger.error(`❌ Error for ${chargeStation.id} connector ${connectorId}: ${err.message}`);
          });

        allPromises.push(p);
      });
    });

    await Promise.allSettled(allPromises);
    this.logger.info('✅ All connectors triggered for StatusNotification');
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
      
      try {
        connection.ws.send(JSON.stringify(message));
      } catch (error: any) {
        clearTimeout(timeout);
        reject(new Error(`Failed to send message: ${error.message}`));
      }
    });
  }

  private async handleMessage(chargePointId: string, data: any): Promise<void> {
    try {
      const connection = this.connections.get(chargePointId);
      if (!connection) {
        this.logger.warn(`⚠️ Message received from unknown charge point: ${chargePointId}`);
        return;
      }
      
      connection.lastSeen = new Date();
      connection.isAlive = true;

      const message = JSON.parse(data.toString());
      const response = await this.messageHandler.handleMessage(chargePointId, message, connection);
      
      if (response) {
        connection.ws.send(JSON.stringify(response));
        this.logger.debug(`📤 Response sent to ${chargePointId}`);
      }

      // Update real-time data
      await this.updateRealTimeData(chargePointId, message, connection);

    } catch (error: any) {
      this.logger.error(`❌ Error handling message from ${chargePointId}: ${error.message}`);
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

          connection.connectors.forEach((connectorData) => {
            connectorData.timestamp = new Date();
          });

          this.logger.info(`✅ Boot notification processed for ${chargePointId}`);
          break;

        case 'StatusNotification':
          const connectorId = payload.connectorId || 0;

          if (!connection.connectors.has(connectorId)) {
            connection.connectors.set(
              connectorId,
              this.getDefaultChargingData(chargePointId, connectorId)
            );
            this.logger.info(`🆕 Discovered new connector ${connectorId} for ${chargePointId}`);
          }

          const connectorData = connection.connectors.get(connectorId)!;
          connectorData.status = payload.status;
          connectorData.timestamp = new Date();
          connection.connectors.set(connectorId, connectorData);

          try {
            await this.db.updateConnectorStatus(
              chargePointId,
              connectorId,
              payload.status,
              payload.errorCode,
              payload.vendorErrorCode
            );
            this.logger.debug(`💾 DB updated: ${chargePointId} connector ${connectorId} → ${payload.status}`);
          } catch (dbError) {
            this.logger.error(`⚠️ Failed to update database: ${dbError}`);
          }
          break;

        case 'MeterValues':
          this.processMeterValues(connection, payload);
          
          const meterConnectorId = payload.connectorId || 1;
          if (connection.connectors.has(meterConnectorId)) {
            const meterConnectorData = connection.connectors.get(meterConnectorId)!;
            meterConnectorData.timestamp = new Date();
            connection.connectors.set(meterConnectorId, meterConnectorData);

            try {
              await this.db.updateConnectorStatus(chargePointId, meterConnectorId, meterConnectorData.status);
            } catch (dbError) {
              this.logger.error(`⚠️ Failed to update meter data: ${dbError}`);
            }
          }
          this.logger.debug(`📊 Meter values processed for ${chargePointId}`);
          break;

        case 'Heartbeat':
          connection.connectors.forEach(async (connectorData, id) => {
            connectorData.timestamp = new Date();
            connection.connectors.set(id, connectorData);

            try {
              await this.db.updateConnectorStatus(chargePointId, id, connectorData.status);
            } catch (dbError) {
              this.logger.error(`⚠️ Failed to sync heartbeat: ${dbError}`);
            }
          });
          this.logger.debug(`💓 Heartbeat received from ${chargePointId}`);
          break;

        case 'StartTransaction':
          const startConnectorId = payload.connectorId || 1;
          if (connection.connectors.has(startConnectorId)) {
            const startConnectorData = connection.connectors.get(startConnectorId)!;
            startConnectorData.status = 'Charging' as any;
            startConnectorData.connected = true;
            startConnectorData.timestamp = new Date();
            connection.connectors.set(startConnectorId, startConnectorData);

            try {
              await this.db.updateConnectorStatus(chargePointId, startConnectorId, 'CHARGING');
              this.logger.info(`🔌 Transaction started: ${chargePointId} connector ${startConnectorId}`);
            } catch (dbError) {
              this.logger.error(`⚠️ Failed to update transaction start: ${dbError}`);
            }
          }
          break;

        case 'StopTransaction':
          const stopConnectorId = payload.connectorId || 1;
          if (connection.connectors.has(stopConnectorId)) {
            const stopConnectorData = connection.connectors.get(stopConnectorId)!;
            stopConnectorData.status = 'Available' as any;
            stopConnectorData.connected = false;
            stopConnectorData.stopReason = payload.reason || null;
            stopConnectorData.timestamp = new Date();
            connection.connectors.set(stopConnectorId, stopConnectorData);

            try {
              await this.db.updateConnectorStatus(chargePointId, stopConnectorId, 'AVAILABLE');
              this.logger.info(`⏹️ Transaction stopped: ${chargePointId} connector ${stopConnectorId}`);
            } catch (dbError) {
              this.logger.error(`⚠️ Failed to update transaction stop: ${dbError}`);
            }
          }
          break;

        default:
          this.logger.debug(`📩 Message ${action} from ${chargePointId}`);
      }

      // Store connectors in Redis and sync to database
      if (connection.connectors.size > 0) {
        const connectorsArray = Array.from(connection.connectors.values());

        try {
          await this.redis.setJSON(
            `chargepoint:${chargePointId}:connectors`,
            connectorsArray,
            3600
          );

          for (const connector of connectorsArray) {
            await this.db.updateConnectorStatus(chargePointId, connector.connectorId, connector.status);
          }
          this.logger.debug(`🔄 Synced data for ${chargePointId}`);
        } catch (error) {
          this.logger.error(`⚠️ Failed to sync data: ${error}`);
        }
      }

    } catch (error) {
      this.logger.error(`❌ Error updating real-time data: ${error}`);
    }
  }

  public async getAllChargeStationsStructured(): Promise<{
    chargeStations: Record<string, { connectors: Record<number, ChargingStationData> }>;
  }> {
    const structuredData: {
      chargeStations: Record<string, { connectors: Record<number, ChargingStationData> }>;
    } = { chargeStations: {} };

    try {
      // Get data from active connections first
      this.connections.forEach((connection, stationId) => {
        const stationData: { connectors: Record<number, ChargingStationData> } = { connectors: {} };
        connection.connectors.forEach((connectorData, connectorId) => {
          stationData.connectors[connectorId] = { ...connectorData };
        });
        structuredData.chargeStations[stationId] = stationData;
      });

      if (Object.keys(structuredData.chargeStations).length === 0) {
        try {
          const cachedData = await this.redis.get('chargeStations:all');
          if (cachedData) {
            const parsedData = JSON.parse(cachedData);
            if (parsedData?.chargeStations) {
              this.logger.info('📦 Retrieved data from Redis cache');
              return parsedData;
            }
          }
        } catch (error) {
          this.logger.warn(`⚠️ Redis cache error: ${error}`);
        }

        // Fallback to database
        try {
          const dbChargePoints = await this.db.getAllChargePoints() as any[];
          if (dbChargePoints?.length > 0) {
            this.logger.info(`📦 Retrieved ${dbChargePoints.length} charge points from database`);
            
            for (const chargePoint of dbChargePoints) {
              if (chargePoint.connectors?.length > 0) {
                const stationData: { connectors: Record<number, ChargingStationData> } = { connectors: {} };
                
                chargePoint.connectors.forEach((connector: any) => {
                  stationData.connectors[connector.connectorId] = {
                    chargePointId: chargePoint.id,
                    connectorId: connector.connectorId,
                    gunType: connector.type || 'TYPE2',
                    status: connector.status || 'Unavailable',
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
                    timestamp: connector.updatedAt || new Date()
                  };
                });
                
                structuredData.chargeStations[chargePoint.id] = stationData;
              }
            }
          }
        } catch (error) {
          this.logger.error(`❌ Database retrieval failed: ${error}`);
        }
      }

      if (Object.keys(structuredData.chargeStations).length > 0) {
        await this.redis.set('chargeStations:all', JSON.stringify(structuredData), 30);
      }
      
      this.logger.debug(`📊 Found ${Object.keys(structuredData.chargeStations).length} charge stations`);
      return structuredData;
    } catch (error) {
      this.logger.error(`❌ Error getting charge stations: ${error}`);
      return structuredData;
    }
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
    const ocppMessage = [2, messageId, "ChangeConfiguration", { key, value }];

    try {
      client.send(JSON.stringify(ocppMessage));
      this.logger.info(`✅ ChangeConfiguration sent to ${chargePointId}: ${key}=${value}`);
    } catch (error: any) {
      this.logger.error(`❌ Failed to send ChangeConfiguration: ${error.message}`);
      throw error;
    }

    return messageId;
  }

  private processMeterValues(connection: ChargePointConnection, payload: any): void {
    if (!payload.meterValue || !Array.isArray(payload.meterValue)) return;

    const connectorId = payload.connectorId || 1;
    
    if (!connection.connectors.has(connectorId)) {
      connection.connectors.set(connectorId, this.getDefaultChargingData(connection.id, connectorId));
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
    let configResponse;
    
    if (!connection) {
      this.logger.warn(`❌ Charge point ${chargePointId} not connected`);
      return null;
    }

    const errors: string[] = [];
    let discoveryMethod = "unknown";
    let configuredCount: number | undefined;

    try {
      this.logger.info(`🔍 Starting connector discovery for ${chargePointId}`);

      // Step 1: Get NumberOfConnectors from configuration
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

            this.logger.info(`✅ Found ${configuredCount} connectors for ${chargePointId}`);

            for (let i = 1; i <= configuredCount; i++) {
              if (!connection.connectors.has(i)) {
                connection.connectors.set(i, this.getDefaultChargingData(chargePointId, i));
              }
            }
          }
        }
      } catch (error: any) {
        errors.push(`GetConfiguration failed: ${error?.message ?? error}`);
        this.logger.debug(`⚠️ GetConfiguration failed: ${error}`);
      }

      // Step 2: Trigger StatusNotification
      try {
        await this.sendMessage(chargePointId, "TriggerMessage", {
          requestedMessage: "StatusNotification",
        });
        this.logger.debug(`🔔 Triggered StatusNotification for ${chargePointId}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error: any) {
        errors.push(`TriggerMessage failed: ${error?.message ?? error}`);
      }

      // Step 3: Trigger individual connector status
      if (configuredCount) {
        const triggerPromises = [];
        for (let i = 1; i <= configuredCount; i++) {
          triggerPromises.push(
            this.sendMessage(chargePointId, "TriggerMessage", {
              requestedMessage: "StatusNotification",
              connectorId: i,
            }).catch((error: any) => {
              errors.push(`TriggerMessage connector ${i} failed: ${error?.message ?? error}`);
            })
          );
        }
        await Promise.allSettled(triggerPromises);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      // Step 4: Get MeterValues
      try {
        if (connection.connectors.size > 0) {
          const meterPromises = [];
          for (const connectorId of connection.connectors.keys()) {
            meterPromises.push(
              this.sendMessage(chargePointId, "TriggerMessage", {
                requestedMessage: "MeterValues",
                connectorId,
              }).catch((error: any) => {
                this.logger.debug(`MeterValues trigger failed: ${error}`);
              })
            );
          }
          await Promise.allSettled(meterPromises);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      } catch (error: any) {
        this.logger.debug(`MeterValues failed: ${error}`);
      }

      const finalConnectors = Array.from(connection.connectors.values());
      const finalCount = finalConnectors.length;

      if (finalCount > 0 && discoveryMethod === "unknown") {
        discoveryMethod = "passive_monitoring";
      }

      if (configuredCount && finalCount !== configuredCount) {
        errors.push(`Mismatch: configured=${configuredCount}, discovered=${finalCount}`);
      }

      this.logger.info(`✅ Discovery complete for ${chargePointId}: ${finalCount} connectors`);

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
      this.logger.error(`❌ Discovery error: ${error.message}`);
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
          errors: [...errors, `Error: ${error?.message ?? error}`],
        },
      };
    }
  }

  private handleError(chargePointId: string, error: Error): void {
    this.logger.error(`⚠️ WebSocket error for ${chargePointId}: ${error.message}`);
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
          this.logger.warn(`❌ Terminating dead connection: ${chargePointId}`);
          connection.ws.terminate();
          this.connections.delete(chargePointId);
          return;
        }

        connection.isAlive = false;
        try {
          connection.ws.ping();
        } catch (error) {
          this.logger.error(`⚠️ Ping failed for ${chargePointId}`);
        }
      });
    }, 30000);
  }

  public sendCallError(chargePointId: string, uniqueId: string, errorCode: string, errorDescription: string): void {
    const connection = this.connections.get(chargePointId);
    if (!connection) return;

    const errorMessage = [MessageType.CALLERROR, uniqueId, errorCode, errorDescription, {}];
    try {
      connection.ws.send(JSON.stringify(errorMessage));
    } catch (error) {
      this.logger.error(`⚠️ Failed to send error: ${error}`);
    }
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
      
      try {
        connection.ws.send(JSON.stringify(message));
      } catch (error: any) {
        clearTimeout(timeout);
        reject(new Error(`Failed to send message: ${error.message}`));
      }
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
      try {
        const connectorIds = Array.from(connection.connectors.keys());
        for (const connectorId of connectorIds) {
          try {
            await this.db.updateConnectorStatus(chargePointId, connectorId, "UNAVAILABLE");
            this.logger.debug(`🔌 Connector ${connectorId} marked UNAVAILABLE`);
          } catch (error) {
            this.logger.error(`⚠️ Failed to update connector ${connectorId}: ${error}`);
          }
        }
        this.logger.info(`✅ All connectors marked offline for ${chargePointId}`);
      } catch (error) {
        this.logger.error(`❌ Disconnection handling error: ${error}`);
      }
      
      try {
        await this.redis.setJSON(
          `chargepoint:${chargePointId}:status`,
          { status: 'unavailable', disconnectedAt: new Date() },
          3600
        );
      } catch (error) {
        this.logger.error(`⚠️ Redis update failed: ${error}`);
      }
    }
    
    this.connections.delete(chargePointId);
    this.chargePointManager.unregisterChargePoint(chargePointId);
    this.logger.info(`📴 Charge point ${chargePointId} disconnected`);
  }
}