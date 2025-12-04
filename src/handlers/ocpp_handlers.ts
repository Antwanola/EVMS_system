// src/handlers/ocpp-message-handler.ts
import { OCPPServer } from "../services/ocpp_server";
import { Logger } from "../Utils/logger";
import { DatabaseService } from "../services/database";
import { RedisService } from "../services/redis";
import {
  OCPPMessage,
  MessageType,
  ChargePointConnection,
  BootNotificationRequest,
  BootNotificationResponse,
  HeartbeatResponse,
  StatusNotificationRequest,
  StatusNotificationResponse,
  MeterValuesRequest,
  MeterValuesResponse,
  StartTransactionRequest,
  StartTransactionResponse,
  StopTransactionRequest,
  StopTransactionResponse,
  AuthorizeRequest,
  AuthorizeResponse,
  ChargingStationData,
} from "../types/ocpp_types";
import { APIGateway } from "../services/api_gateway";
import crypto from "crypto"
import { idTagStatus } from "../helpers/helper";

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeout: NodeJS.Timeout;
}

export class OCPPMessageHandler {
  private readonly logger = Logger.getInstance();
  private readonly pendingCalls = new Map<string, PendingCall>();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly apiGateway: APIGateway
  ) {}

  // ==================== MESSAGE ROUTING ====================

  public async handleMessage(
    chargePointId: string,
    message: OCPPMessage,
    connection: ChargePointConnection
  ): Promise<any> {
    const [messageTypeId, uniqueId, actionOrErrorCode, payload] = message as any;

    switch (messageTypeId) {
      case MessageType.CALL:
        return this.handleCall(
          chargePointId,
          uniqueId,
          actionOrErrorCode,
          payload,
          connection
        );

      case MessageType.CALLRESULT:
        this.handleCallResult(uniqueId, actionOrErrorCode);
        return null;

      case MessageType.CALLERROR:
        this.handleCallError(uniqueId, actionOrErrorCode, payload);
        return null;

      default:
        this.logger.error(`Unknown message type: ${messageTypeId}`);
        return null;
    }
  }

  // ==================== PENDING CALLS MANAGEMENT ====================

  public addPendingCall(
    uniqueId: string,
    resolve: (value: any) => void,
    reject: (reason?: any) => void,
    timeout: NodeJS.Timeout
  ): void {
    this.pendingCalls.set(uniqueId, { resolve, reject, timeout });
  }

  public removePendingCall(uniqueId: string): void {
    const pending = this.pendingCalls.get(uniqueId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCalls.delete(uniqueId);
    }
  }

  public resolvePendingCall(uniqueId: string, response: any): void {
    const pending = this.pendingCalls.get(uniqueId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(response);
      this.pendingCalls.delete(uniqueId);
    }
  }

  public rejectPendingCall(uniqueId: string, error: any): void {
    const pending = this.pendingCalls.get(uniqueId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingCalls.delete(uniqueId);
    }
  }

  private handleCallResult(uniqueId: string, payload: any): void {
    this.logger.debug('Call result received:', payload);
    this.resolvePendingCall(uniqueId, payload);
  }

  private handleCallError(uniqueId: string, errorCode: string, errorDescription: string): void {
    this.logger.warn(`Call error: ${errorCode} - ${errorDescription}`);
    this.rejectPendingCall(uniqueId, new Error(`${errorCode}: ${errorDescription}`));
  }

  // ==================== CALL HANDLER ====================

  private async handleCall(
    chargePointId: string,
    uniqueId: string,
    action: string,
    payload: any,
    connection: ChargePointConnection
  ): Promise<any> {

    try {
      let response: any;

      switch (action) {
        case "BootNotification":
          response = await this.handleBootNotification(chargePointId, payload, connection);
          break;

        case "Heartbeat":
          response = await this.handleHeartbeat(chargePointId, connection);
          break;

        case "StatusNotification":
          response = await this.handleStatusNotification(chargePointId, payload, connection);
          break;

        case "MeterValues":
          response = await this.handleMeterValues(chargePointId, payload, connection);
          break;

        case "StartTransaction":
          response = await this.handleStartTransaction(chargePointId, payload, connection);
          break;

        case "StopTransaction":
          response = await this.handleStopTransaction(chargePointId, payload, connection);
          break;

        case "Authorize":
          response = await this.handleAuthorize(chargePointId, payload, connection);
          break;

        default:
          this.logger.warn(`Unhandled action: ${action}`);
          return [
            MessageType.CALLERROR,
            uniqueId,
            "NotSupported",
            `Action ${action} not supported`,
            {},
          ];
      }
      console.log("result sent to mac", [MessageType.CALLRESULT, uniqueId, response])

      return [MessageType.CALLRESULT, uniqueId, response];
    } catch (error) {
      this.logger.error(`Error handling ${action}:`, error);
      return [
        MessageType.CALLERROR,
        uniqueId,
        "InternalError",
        "Internal server error",
        {},
      ];
    }
  }

  // ==================== OCPP MESSAGE HANDLERS ====================

  private async handleBootNotification(
    chargePointId: string,
    payload: BootNotificationRequest,
    connection: ChargePointConnection
  ): Promise<BootNotificationResponse> {
    this.logger.info(`Boot notification from ${chargePointId}:`, payload);

    await this.db.createOrUpdateChargePoint({
      id: chargePointId,
      vendor: payload.chargePointVendor,
      model: payload.chargePointModel,
      serialNumber: payload.chargePointSerialNumber,
      firmwareVersion: payload.firmwareVersion,
      iccid: payload.iccid,
      imsi: payload.imsi,
      meterType: payload.meterType,
      meterSerialNumber: payload.meterSerialNumber,
    });

    connection.bootNotificationSent = true;
    connection.heartbeatInterval = 300; // 5 minutes

    return {
      status: "Accepted",
      currentTime: new Date().toISOString(),
      interval: connection.heartbeatInterval,
    };
  }

  private async handleHeartbeat(
    chargePointId: string,
    connection: ChargePointConnection
  ): Promise<HeartbeatResponse> {
    await this.db.updateChargePointStatus(chargePointId, true);

    return {
      currentTime: new Date().toISOString(),
    };
  }

  private async handleStatusNotification(
    chargePointId: string,
    payload: StatusNotificationRequest,
    connection: ChargePointConnection
  ): Promise<StatusNotificationResponse> {
    this.logger.info(`Status notification from ${chargePointId}:`, { payload });

    const connectorId = payload.connectorId || 1;

    // Get or create connector data
    if (!connection.connectors.has(connectorId)) {
      connection.connectors.set(connectorId, this.getDefaultChargingData(chargePointId, connectorId));
      this.logger.info(`Created new connector ${connectorId} for ${chargePointId}`);
    }

    const connectorData = connection.connectors.get(connectorId)!;

    // Update connector data
    connectorData.status = payload.status as any;
    connectorData.connectorId = payload.connectorId;
    connectorData.timestamp = new Date();

    console.log('Connector Data before update:', connectorData);

    // Update database
    await this.db.updateConnectorStatus(
      chargePointId,
      payload.connectorId,
      payload.status,
      payload.errorCode,
      payload.vendorErrorCode
    );

    // Handle alarms if there's an error
    if (payload.errorCode && payload.errorCode !== "NoError") {
      await this.db.createAlarm({
        chargePointId,
        connectorId: payload.connectorId,
        alarmType: payload.errorCode,
        severity: this.getAlarmSeverity(payload.errorCode),
        message: payload.info || `Error: ${payload.errorCode}`,
      });

      connectorData.alarm = payload.errorCode;
    } else {
      connectorData.alarm = null;
    }

    // Save updated connector data back to the Map
    connection.connectors.set(connectorId, connectorData);

    console.log('All Connectors:', Array.from(connection.connectors.values()));

    return {};
  }

  private handleMeterValues(
    chargePointId: string,
    payload: MeterValuesRequest,
    connection: ChargePointConnection
  ) {
    for (const meterValue of payload.meterValue) {
      console.log("meterValues", meterValue)
      const sampledValues = meterValue.sampledValue.map((sv) => ({
        value: sv.value,
        context: sv.context,
        format: sv.format,
        measurand: sv.measurand,
        phase: sv.phase,
        location: sv.location,
        unit: sv.unit,
      }));
      this.apiGateway.sendMeterValueToClients({
        chargePointId,
        timestamp: meterValue.timestamp,
        sampledValues,
      })
      // await this.db.saveMeterValues({
      //   transactionId: payload.transactionId,
      //   connectorId: payload.connectorId,
      //   chargePointId,
      //   timestamp: new Date(meterValue.timestamp),
      //   sampledValues,
      // });
    }
  }

  private async handleStartTransaction(
    chargePointId: string,
    payload: StartTransactionRequest,
    connection: ChargePointConnection
  ): Promise<StartTransactionResponse> {
    this.logger.info(`Start transaction from ${chargePointId}:`, payload);
    console.log("The start config", { StartTransaction: payload });
    let accepted;

    const connectorId = payload.connectorId
    const idTagValidation = await this.db.validateIdTag(payload.idTag);

    if (idTagValidation.status !== "ACCEPTED") {
      return {
        transactionId: -1,
        idTagInfo: {
          status: idTagValidation.status as any,
          expiryDate: idTagValidation.expiryDate?.toISOString(),
        },
      };
    }

    const transactionId = 100000 + crypto.randomInt(0, 900000);
    console.log({ transactionId });

    const transaction = await this.db.createTransaction({
      transactionId: transactionId,
      chargePointId,
      connectorId: payload.connectorId,
      idTag: payload.idTag,
      meterStart: payload.meterStart,
      startTimestamp: new Date(payload.timestamp),
      reservationId: payload.reservationId,
    });

    await this.db.createOrUpdateConnector(
      chargePointId,
      payload.connectorId,
      payload,
      transactionId
    );

    // Update connector data
    const connectorData = connection.connectors.get(connectorId)!;
    connectorData.status = "Charging" as any;
    connectorData.connected = true;
    connectorData.timestamp = new Date();
    connection.connectors.set(connectorId, connectorData);

    return {
      transactionId:transactionId,
      idTagInfo: {
        status: "Accepted",
        expiryDate: idTagValidation.expiryDate?.toISOString(),
      },
    };
  }

  private async handleStopTransaction(
    chargePointId: string,
    payload: StopTransactionRequest,
    connection: ChargePointConnection
  ): Promise<StopTransactionResponse> {
    this.logger.info(`Stop transaction from ${chargePointId}:`, payload);

    const transaction = await this.db.getTransaction(payload.transactionId);
    console.log({ StopTransaction: payload, transaction });

    if (!transaction) {
      return {
        idTagInfo: {
          status: "Invalid",
        },
      };
    }

    const connectorId = transaction.connectorId || 1;

    await this.db.stopTransaction(
      payload.transactionId,
      payload.meterStop,
      new Date(payload.timestamp),
      payload.reason
    );

    await this.db.updateConnectorStatus(
      chargePointId,
      transaction.connectorId,
      "AVAILABLE"
    );

    // Update connector data
    if (connection.connectors.has(connectorId)) {
      const connectorData = connection.connectors.get(connectorId)!;
      connectorData.status = "Available" as any;
      connectorData.connected = false;
      connectorData.stopReason = payload.reason || null;
      connectorData.chargingEnergy = payload.meterStop -  transaction.meterStart;
      connectorData.timestamp = new Date();
      connection.connectors.set(connectorId, connectorData);
    }

    // Process transaction data if provided
    if (payload.transactionData) {
      for (const meterValue of payload.transactionData) {
        const sampledValues = meterValue.sampledValue.map((sv) => ({
          value: sv.value,
          context: sv.context,
          format: sv.format,
          measurand: sv.measurand,
          phase: sv.phase,
          location: sv.location,
          unit: sv.unit,
        }));

        await this.db.saveMeterValues({
          transactionId: payload.transactionId,
          connectorId: transaction.connectorId,
          chargePointId,
          timestamp: new Date(meterValue.timestamp),
          sampledValues,
        });
      }
    }

    return {
      idTagInfo: {
        status: "Accepted",
      },
    };
  }

  private async handleAuthorize(
    chargePointId: string,
    payload: AuthorizeRequest,
    connection: ChargePointConnection
  ): Promise<AuthorizeResponse> {
    this.logger.info(`Authorize request from ${chargePointId}:`, payload);

    const idTagValidation = await this.db.validateIdTag(payload.idTag);

    return {
      idTagInfo: {
        status: idTagStatus(idTagValidation.status as any),
        expiryDate: idTagValidation.expiryDate?.toISOString(),
      },
    };
  }

  // ==================== HELPERS ====================

  private getAlarmSeverity(
    errorCode: string
  ): "INFO" | "WARNING" | "ERROR" | "CRITICAL" {
    const criticalErrors = [
      "GroundFailure",
      "HighTemperature",
      "InternalError",
    ];
    const errorCodes = ["PowerMeterFailure", "ReaderFailure", "ResetFailure"];
    const warningCodes = [
      "ConnectorLockFailure",
      "EVCommunicationError",
      "PowerSwitchFailure",
    ];

    if (criticalErrors.includes(errorCode)) return "CRITICAL";
    if (errorCodes.includes(errorCode)) return "ERROR";
    if (warningCodes.includes(errorCode)) return "WARNING";

    return "INFO";
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