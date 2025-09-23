// src/services/ocpp-server.ts
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http'
import { v4 as uuidv4 } from 'uuid';
import  {Logger}  from '../Utils/logger';
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
import { buffer } from 'stream/consumers';

export class OCPPServer {
  private logger = Logger.getInstance();
  private connections = new Map<string, ChargePointConnection>();
  private messageHandler: OCPPMessageHandler;
  private chargePointManager: ChargePointManager;

  constructor(
    // private server: HttpServer,
    private wss: WebSocketServer,
    private db: DatabaseService,
    private redis: RedisService
  ) {
    this.messageHandler = new OCPPMessageHandler(this.db, this.redis);
    this.chargePointManager = new ChargePointManager(this.db, this.redis);
  }

  public initialize(): void {
    this.wss.on('connection', this.handleConnection.bind(this));
    this.setupHeartbeatCheck();
    this.logger.info('OCPP Server initialized');
  }

  private handleConnection(ws: WebSocket, request: any): void {
    const url = new URL(request.url!, `http://${request.headers.host}`);
      const pathSegments = url.pathname.split('/').filter(Boolean); // remove empty segments
    const chargePointId = pathSegments[pathSegments.length - 1]; // last segment is ID
    console.log({chargePointId})
    console.log({pathSegments})

    if (!chargePointId) {
      this.logger.warn('Connection rejected: No charge point ID provided');
      ws.close(1008, 'Charge point ID required');
      return;
    }

  // const defaultConnectors = parseInt(process.env.DEFAULT_CONNECTORS || '2');
  const connectors = new Map<number, ChargingStationData>();
  
    const connection: ChargePointConnection = {
      id: chargePointId,
      ws,
      isAlive: true,
      lastSeen: new Date(),
      bootNotificationSent: false,
      heartbeatInterval: 300000, // 5 minutes default
      currentData: this.getDefaultChargingData(chargePointId, 1),
      connectors,
      numberOfConnectors: connectors.size,
      meters: new Map<string, any>()
    };

    this.connections.set(chargePointId, connection);
    this.logger.info(`Charge point ${chargePointId} connected with ${connection.numberOfConnectors} connectors`);


    // Setup WebSocket event handlers
    ws.on('message', (data) => this.handleMessage(chargePointId, data));
    ws.on('close', () => this.handleDisconnection(chargePointId));
    ws.on('error', (error) => this.handleError(chargePointId, error));
    ws.on('pong', () => this.handlePong(chargePointId));

    // Register charge point
    this.chargePointManager.registerChargePoint(chargePointId, connection);
  }


  // Main method: triggers StatusNotification for all connectors of all charge points
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

    // Wait for all TriggerMessages to finish
    await Promise.allSettled(allPromises);
    console.log('All connectors triggered for StatusNotification');
  }



   // Helper to send TriggerMessage for one connector
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

      // Store resolver in messageHandler (assuming you have a pendingCalls map)
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

      const message: OCPPMessage = JSON.parse(data.toString());
      this.logger.debug(`Received message from ${chargePointId}:`, message);

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
    message: OCPPMessage, 
    connection: ChargePointConnection
  ): Promise<void> {
    try {
      // Update connection's current data based on message type
      switch (message.action) {
        case 'StatusNotification':
          connection.currentData!.status = message.payload.status;
          connection.currentData!.timestamp = new Date();
          break;
        
        case 'MeterValues':
          this.processMeterValues(connection, message.payload);
          break;
      }

      // Store in Redis for real-time access
      await this.redis.set(
        `chargepoint:${chargePointId}:data`,
        JSON.stringify(connection.currentData),
        3600 // 1 hour TTL
      );

      // Store in database for historical data
      await this.db.saveChargingData(connection.currentData!);

    } catch (error) {
      this.logger.error(`Error updating real-time data for ${chargePointId}:`, error);
    }
  }


//   private async updateRealTimeData(
//   chargePointId: string, 
//   message: OCPPMessage, 
//   connection: ChargePointConnection
// ): Promise<void> {
//   try {
//     switch (message.action) {
//       case 'StatusNotification':
//         const connectorId = message.payload.connectorId || 1;
//         const connectorData = connection.connectors.get(connectorId);
//         console.log({connectorData})
//        if (!connection.connectors.has(connectorId)) {
//           connection.connectors.set(connectorId,
//             this.getDefaultChargingData(chargePointId, connectorId)
//           );
//           this.logger.info(`Discovered new connector ${connectorId} for ${chargePointId}`);
//         }
//         break;
      
//       case 'MeterValues':
//         const meterConnectorId = message.payload.connectorId || 1;
//         const meterConnectorData = connection.connectors.get(meterConnectorId);
//         if (meterConnectorData) {
//           this.processMeterValues(meterConnectorData:, message.payload);
//           connection.connectors.set(meterConnectorId, meterConnectorData);
//         }
//         break;

//       case 'StartTransaction':
//         const startConnectorId = message.payload.connectorId || 1;
//         const startConnectorData = connection.connectors.get(startConnectorId);
//         if (startConnectorData) {
//           // startConnectorData.status = 'Charging';
//           startConnectorData.connected = true;
//           startConnectorData.timestamp = new Date();
//           connection.connectors.set(startConnectorId, startConnectorData);
//         }
//         break;

//       case 'StopTransaction':
//         // Find connector by transaction ID or use connector 1 as fallback
//         const stopConnectorId = message.payload.connectorId || 1;
//         const stopConnectorData = connection.connectors.get(stopConnectorId);
//         if (stopConnectorData) {
//           // stopConnectorData.status = 'Available';
//           stopConnectorData.connected = false;
//           stopConnectorData.timestamp = new Date();
//           connection.connectors.set(stopConnectorId, stopConnectorData);
//         }
//         break;
//     }

//     // Store all connector data in Redis
//     const connectorsData = Array.from(connection.connectors.entries()).map(([id, data]) => ({
//       // connectorId: id,
//       ...data
//     }));

//     await this.redis.set(
//       `chargepoint:${chargePointId}:connectors`,
//       JSON.stringify(connectorsData),
//       3600
//     );

//     // Store in database
//     for (const [connectorId, connectorData] of connection.connectors) {
//       await this.db.saveChargingData(connectorData);
//     }

//   } catch (error) {
//     this.logger.error(`Error updating real-time data for ${chargePointId}:`, error);
//   }
// }

  private processMeterValues(connection: ChargePointConnection, payload: any): void {
    if (!payload.meterValue || !Array.isArray(payload.meterValue)) return;

    payload.meterValue.forEach((meterValue: any) => {
      if (!meterValue.sampledValue) return;

      meterValue.sampledValue.forEach((sample: any) => {
        switch (sample.measurand) {
          case 'Voltage':
            if (sample.location === 'Inlet') {
              connection.currentData!.inputVoltage = parseFloat(sample.value);
            } else if (sample.location === 'Outlet') {
              connection.currentData!.outputVoltage = parseFloat(sample.value);
            }
            break;
          
          case 'Current.Import':
            if (sample.location === 'Inlet') {
              connection.currentData!.inputCurrent = parseFloat(sample.value);
            } else {
              connection.currentData!.demandCurrent = parseFloat(sample.value);
            }
            break;
          
          case 'Energy.Active.Import.Register':
            connection.currentData!.chargingEnergy = parseFloat(sample.value);
            break;
          
          case 'Power.Active.Import':
            connection.currentData!.outputEnergy = parseFloat(sample.value);
            break;
          
          case 'Temperature':
            connection.currentData!.gunTemperature = parseFloat(sample.value);
            break;
          
          case 'SoC':
            connection.currentData!.stateOfCharge = parseFloat(sample.value);
            break;
        }
      });
    });

    connection.currentData!.timestamp = new Date();
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
      configResponse = await this.sendMessage(chargePointId, "MeterValues", {
        // key: ["HeartbeatInterval"],
      });
      console.log(`GetConfiguration response for ${chargePointId}:`, configResponse);
      if(configResponse){
        console.log(configResponse)
      }
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

    // Step 5: Passive discovery fallback
    let discoveredCount = connection.connectors.size;

    if (discoveredCount === 0 && !configuredCount) {
      discoveryMethod = "probe_common_ids";
      const commonIds = [1, 2, 3, 4];

      for (const id of commonIds) {
        try {
          await this.sendMessage(chargePointId, "TriggerMessage", {
            requestedMessage: "StatusNotification",
            connectorId: id,
          });
        } catch {
          break; // stop on first failure
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      discoveredCount = connection.connectors.size;
    }

    // Step 6: Compile results
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

  private handleDisconnection(chargePointId: string): void {
    this.connections.delete(chargePointId);
    this.chargePointManager.unregisterChargePoint(chargePointId);
    this.logger.info(`Charge point ${chargePointId} disconnected`);
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
    }, 30000); // Check every 30 seconds
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

      // Store promise resolver for response handling
      this.messageHandler.addPendingCall(uniqueId, resolve, reject, timeout);
      
      connection.ws.send(JSON.stringify(message));
    });
  }

  public getConnectedChargePoints(): string[] {
    return Array.from(this.connections.keys());
  }

  public getChargePointData(chargePointId: string): ChargingStationData | null {
    const connection = this.connections.get(chargePointId);
   
    return connection ? connection.currentData! : null;
  }

  public getAllChargePointsData(): Map<string, ChargingStationData> {
    const data = new Map<string, ChargingStationData>();
    this.connections.forEach((connection, id) => {
      data.set(id, connection.currentData!);
    });
    return data;
  }

  private getDefaultChargingData(chargePointId: string, connectorId: number): ChargingStationData {
    this.triggerStatusForAll()
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
  

/**
 * Get specific connector data
 */
public getChargePointConnector(chargePointId: string, connectorId: number): ChargingStationData | null {
  const connection = this.connections.get(chargePointId);
  if (!connection) return null;
  
  return connection.connectors.get(connectorId) || null;
}

/**
 * Get connector count for a charge point
 */
public getConnectorCount(chargePointId: string): number {
  const connection = this.connections.get(chargePointId);
  if (!connection) return 0;
  
  return connection.connectors.size;
}

/**
 * Enhanced method to get all charge points with connector arrays
 */
public getAllChargePointsConnectorData(): Map<string, ChargingStationData[]> {
  const data = new Map<string, ChargingStationData[]>();
  this.connections.forEach((connection, id) => {
    const connectors = Array.from(connection.connectors.values());
    data.set(id, connectors);
  });
  return data;
}

}

