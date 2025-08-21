// src/services/ocpp-server.ts
import { WebSocketServer, WebSocket } from 'ws';
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

export class OCPPServer {
  private logger = Logger.getInstance();
  private connections = new Map<string, ChargePointConnection>();
  private messageHandler: OCPPMessageHandler;
  private chargePointManager: ChargePointManager;

  constructor(
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
    const chargePointId = url.pathname.split('/').pop();

    if (!chargePointId) {
      this.logger.warn('Connection rejected: No charge point ID provided');
      ws.close(1008, 'Charge point ID required');
      return;
    }

    const connection: ChargePointConnection = {
      id: chargePointId,
      ws,
      isAlive: true,
      lastSeen: new Date(),
      bootNotificationSent: false,
      heartbeatInterval: 300000, // 5 minutes default
      currentData: this.getDefaultChargingData(chargePointId, 1)
    };

    this.connections.set(chargePointId, connection);
    this.logger.info(`Charge point ${chargePointId} connected`);

    // Setup WebSocket event handlers
    ws.on('message', (data) => this.handleMessage(chargePointId, data));
    ws.on('close', () => this.handleDisconnection(chargePointId));
    ws.on('error', (error) => this.handleError(chargePointId, error));
    ws.on('pong', () => this.handlePong(chargePointId));

    // Register charge point
    this.chargePointManager.registerChargePoint(chargePointId, connection);
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
          connection.currentData.status = message.payload.status;
          connection.currentData.timestamp = new Date();
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
      await this.db.saveChargingData(connection.currentData);

    } catch (error) {
      this.logger.error(`Error updating real-time data for ${chargePointId}:`, error);
    }
  }

  private processMeterValues(connection: ChargePointConnection, payload: any): void {
    if (!payload.meterValue || !Array.isArray(payload.meterValue)) return;

    payload.meterValue.forEach((meterValue: any) => {
      if (!meterValue.sampledValue) return;

      meterValue.sampledValue.forEach((sample: any) => {
        switch (sample.measurand) {
          case 'Voltage':
            if (sample.location === 'Inlet') {
              connection.currentData.inputVoltage = parseFloat(sample.value);
            } else if (sample.location === 'Outlet') {
              connection.currentData.outputVoltage = parseFloat(sample.value);
            }
            break;
          
          case 'Current.Import':
            if (sample.location === 'Inlet') {
              connection.currentData.inputCurrent = parseFloat(sample.value);
            } else {
              connection.currentData.demandCurrent = parseFloat(sample.value);
            }
            break;
          
          case 'Energy.Active.Import.Register':
            connection.currentData.chargingEnergy = parseFloat(sample.value);
            break;
          
          case 'Power.Active.Import':
            connection.currentData.outputEnergy = parseFloat(sample.value);
            break;
          
          case 'Temperature':
            connection.currentData.gunTemperature = parseFloat(sample.value);
            break;
          
          case 'SoC':
            connection.currentData.stateOfCharge = parseFloat(sample.value);
            break;
        }
      });
    });

    connection.currentData.timestamp = new Date();
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
      this.messageHandler.addPendingCall(uniqueId, resolve, timeout);
      
      connection.ws.send(JSON.stringify(message));
    });
  }

  public getConnectedChargePoints(): string[] {
    return Array.from(this.connections.keys());
  }

  public getChargePointData(chargePointId: string): ChargingStationData | null {
    const connection = this.connections.get(chargePointId);
    return connection ? connection.currentData : null;
  }

  public getAllChargePointsData(): Map<string, ChargingStationData> {
    const data = new Map<string, ChargingStationData>();
    this.connections.forEach((connection, id) => {
      data.set(id, connection.currentData);
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
}