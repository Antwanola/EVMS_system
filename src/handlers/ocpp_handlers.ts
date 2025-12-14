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
import { StopReason } from "@prisma/client";

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeout: NodeJS.Timeout;
}

export class OCPPMessageHandler {
  private readonly logger = Logger.getInstance();
  private readonly pendingCalls = new Map<string, PendingCall>();
  private transactionSocCache = new Map<number, number>();


  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly apiGateway: APIGateway
  ) { }

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

    console.log(`\n📥 handleCall invoked:`);
    console.log(`   chargePointId: ${chargePointId}`);
    console.log(`   uniqueId: ${uniqueId}`);
    console.log(`   action: ${action}`);
    console.log(`   payload:`, payload);

    switch (action) {
      case "BootNotification":
        console.log('🥾 Processing BootNotification...', payload);
        response = await this.handleBootNotification(chargePointId, payload, connection);
        console.log('🥾 BootNotification response:', response);
        break;

      case "Heartbeat":
        console.log('❤️  Processing Heartbeat...');
        response = await this.handleHeartbeat(chargePointId, connection);
        console.log('❤️  Heartbeat response:', response);
        break;

      case "StatusNotification":
        console.log('📊 Processing StatusNotification...', payload);
        response = await this.handleStatusNotification(chargePointId, payload, connection);
        console.log('📊 StatusNotification response:', response);
        break;

      case "MeterValues":
        console.log('⚡ Processing MeterValues...', payload);
        response = await this.handleMeterValues(chargePointId, payload, connection);
        console.log('⚡ MeterValues response:', response);
        break;

      case "StartTransaction":
        console.log('🔋 Processing StartTransaction...', payload);
        response = await this.handleStartTransaction(chargePointId, payload, connection);
        console.log('🔋 StartTransaction response:', response);
        break;

      case "StopTransaction":
        console.log('🛑 Processing StopTransaction...', payload);
        response = await this.handleStopTransaction(chargePointId, payload, connection);
        console.log('🛑 StopTransaction response:', response);
        break;

      case "Authorize":
        console.log('🔐 Processing Authorize...', payload);
        response = await this.handleAuthorize(chargePointId, payload, connection);
        console.log('🔐 Authorize response:', response);
        break;

      default:
        console.warn(`⚠️  Unhandled action: ${action}`);
        this.logger.warn(`Unhandled action: ${action}`);
        const errorResponse = [
          MessageType.CALLERROR,
          uniqueId,
          "NotSupported",
          `Action ${action} not supported`,
          {},
        ];
        console.log('📤 Returning error response:', errorResponse);
        return errorResponse;
    }

    // Build the CALLRESULT response
    const callResultResponse = [MessageType.CALLRESULT, uniqueId, response];
    console.log('📤 Returning CALLRESULT response:', JSON.stringify(callResultResponse));
    console.log('   Format: [MessageType.CALLRESULT(3), uniqueId, responsePayload]\n');
    
    return callResultResponse;

  } catch (error) {
    console.error(`❌ Error handling ${action}:`, error);
    this.logger.error(`Error handling ${action}:`, error);
    const errorResponse = [
      MessageType.CALLERROR,
      uniqueId,
      "InternalError",
      "Internal server error",
      {},
    ];
    console.log('📤 Returning error response:', errorResponse);
    return errorResponse;
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

    return {};
  }

 private async handleMeterValues(
  chargePointId: string,
  payload: MeterValuesRequest,
  connection: ChargePointConnection
) {
  if (
    !payload?.meterValue ||
    !Array.isArray(payload.meterValue) ||
    !payload.transactionId ||
    !payload.connectorId
  ) {
    return {};
  }

  const { connectorId, transactionId } = payload;

  // Track if we've already written startSoC for this transaction in this request
  let startSocWritten = false;

  for (const meterValue of payload.meterValue) {
    const timestamp = meterValue.timestamp ?? new Date().toISOString();

    for (const sv of meterValue.sampledValue || []) {
      console.log("sampled Values from meter: ", sv)
      const measurand = sv.measurand ? sv.measurand : "Energy.Active.Import.Register";
      
      console.log("Processing meter value:", {
        measurand,
        value: sv.value,
        transactionId,
      });

      // Handle SOC - only write startSoC once per transaction
      // stopSoC should ONLY be handled in StopTransaction, not here
      if (measurand === "SoC" && sv.value !== undefined) {
        const soc = Number(sv.value);
        
        if (!Number.isNaN(soc)) {
          // Check if transaction already has startSoC set
          this.transactionSocCache.set(transactionId, soc)
          const transaction = await this.db.getTransaction(transactionId);
          
          if (transaction && !transaction.startSoC && !startSocWritten) {
            // Only write if startSoC is null AND we haven't written it in this request
            try {
              await this.db.writeStartSOCToTXN(transactionId, soc);
              console.log(`✅ Successfully wrote startSoC=${soc}% for transaction ${transactionId}`);
              startSocWritten = true;
            } catch (error) {
              console.error(`❌ Error writing startSoC:`, error);
              // Don't fail the entire meter values request due to SOC write error
            }
          } else if (transaction?.startSoC) {
            console.log(
            `[SoC] tx=${transactionId} soc=${soc}%`
          );
            console.log(
              `ℹ️  startSoC already set to ${transaction.startSoC}% for transaction ${transactionId}, skipping update`
            );
          }
        }
      }

      // Send meter values to clients via API gateway
      this.apiGateway.sendMeterValueToClients({
        chargePointId,
        connectorId,
        transactionId,
        timestamp: new Date(timestamp).toISOString(),
        sampledValue: {
          value: sv.value,
          context: sv.context,
          format: sv.format,
          measurand,
          phase: sv.phase,
          location: sv.location,
          unit: sv.unit,
        },
      });
    }
  }

  // Return proper OCPP acknowledgment
  return {};
}

  // private async handleStartTransaction(
  //   chargePointId: string,
  //   payload: StartTransactionRequest,
  //   connection: ChargePointConnection
  // ): Promise<StartTransactionResponse> {
  //   this.logger.info(`Start transaction from ${chargePointId}:`, payload);
  //   console.log("The start config", { StartTransaction: payload });
  //   let accepted;

  //   const connectorId = payload.connectorId
  //   const idTagValidation = await this.db.validateIdTag(payload.idTag);

  //   if (idTagValidation.status !== "ACCEPTED") {
  //     return {
  //       transactionId: -1,
  //       idTagInfo: {
  //         status: idTagValidation.status as any,
  //         expiryDate: idTagValidation.expiryDate?.toISOString(),
  //       },
  //     };
  //   }

  //   const transactionId = 100000 + crypto.randomInt(0, 900000);
  //   console.log({ transactionId });

  //   const transaction = await this.db.createTransaction({
  //     transactionId: transactionId,
  //     chargePointId,
  //     connectorId: payload.connectorId,
  //     idTag: payload.idTag,
  //     meterStart: payload.meterStart,
  //     startTimestamp: new Date(payload.timestamp),
  //     reservationId: payload.reservationId,
  //   });

  //   await this.db.createOrUpdateConnector(
  //     chargePointId,
  //     payload.connectorId,
  //     payload,
  //     transactionId:transaction.id
  //   );

  //   // Update connector data
  //   const connectorData = connection.connectors.get(connectorId)!;
  //   connectorData.status = "Charging" as any;
  //   connectorData.connected = true;
  //   connectorData.timestamp = new Date();
  //   connection.connectors.set(connectorId, connectorData);

  //   return {
  //     transactionId:transactionId,
  //     idTagInfo: {
  //       status: "Accepted",
  //       expiryDate: idTagValidation.expiryDate?.toISOString(),
  //     },
  //   };
  // }


  private async handleStartTransaction(
    chargePointId: string,
    payload: StartTransactionRequest,
    connection: ChargePointConnection
  ): Promise<StartTransactionResponse> {
    this.logger.info(`Start transaction from ${chargePointId}:`, payload);
    console.log("The start config", { StartTransaction: payload });

    const connectorId = payload.connectorId;
    // const idTagValidation = await this.db.validateIdTag(payload.idTag);

    // if (idTagValidation.status !== "ACCEPTED") {
    //   return {
    //     transactionId: -1,
    //     idTagInfo: {
    //       status: idTagValidation.status as any,
    //       expiryDate: idTagValidation.expiryDate?.toISOString(),
    //     },
    //   };
    // }

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
    console.log({ transaction });

    await this.db.createOrUpdateConnector(
      chargePointId,
      payload.connectorId,
      payload,
      transaction.transactionId
    );

    // Update connector data
    const connectorData = connection.connectors.get(connectorId)!;
    connectorData.status = "Charging" as any;
    connectorData.connected = true;
    connectorData.timestamp = new Date();
    connection.connectors.set(connectorId, connectorData);

    return {
      transactionId: transaction.transactionId,  // ✅ Return DB ID, not random number
      idTagInfo: {
        status: "Accepted",
        // expiryDate: idTagValidation.expiryDate?.toISOString(),
      },
    };
  }


private async handleStopTransaction(
  chargePointId: string,
  payload: StopTransactionRequest,
  connection: ChargePointConnection
): Promise<StopTransactionResponse> {
  this.logger.info(`Stop transaction from ${chargePointId}:`, payload);

  // Get transaction using OCPP transactionId
  const transaction = await this.db.getTransaction(payload.transactionId);
  console.log({ StopTransaction: payload });

  // If transaction not found → still respond Accepted
  if (!transaction) {
    this.logger.warn(
      `StopTransaction ${payload.transactionId} received but no active transaction found for CP ${chargePointId}`
    );

    return {
      idTagInfo: { status: "Accepted" }
    };
  }
  const stopSoc = this.transactionSocCache.get(payload.transactionId) ?? null;

  const stopReasonMap: Record<string, string> = {
    "Local": "LOCAL",
    "Remote": "REMOTE", 
    "Emergency": "EMERGENCY_STOP",
    "EVDisconnected": "EV_DISCONNECTED",
    "HardReset": "HARD_RESET",
    "SoftReset": "SOFT_RESET",
    "Other": "OTHER",
    "PowerLoss": "POWER_LOSS",
    "Reboot": "REBOOT",
    "UnlockCommand": "UNLOCK_COMMAND",
    "DeAuthorized": "DE_AUTHORIZED",
    "EnergyLimitReached": "ENERGY_LIMIT_REACHED",
    "GroundFault": "GROUND_FAULT",
    "ImmediateReset": "IMMEDIATE_RESET",
    "LocalOutOfCredit": "LOCAL_OUT_OF_CREDIT",
    "MasterPass": "MASTER_PASS",
    "OvercurrentFault": "OVERCURRENT_FAULT",
    "PowerQuality": "POWER_QUALITY",
    "SOCLimitReached": "SOC_LIMIT_REACHED",
    "StoppedByEV": "STOPPED_BY_EV",
    "TimeLimitReached": "TIME_LIMIT_REACHED",
    "Timeout": "TIMEOUT",
  };
  const reason = payload.reason;
  const mappedReason = (reason && stopReasonMap[reason] ? stopReasonMap[reason] : "OTHER") as StopReason;

  const connectorId = transaction.connectorId ?? 1;
  const transactionPrimaryKey = transaction.id; // IMPORTANT: Prisma PK

  // Process transactionData for stopSoC BEFORE updating the transaction
  let stopSoC: number | null = null;
  


  // Update the transaction record with stopSoC
  const updateTXN = await this.db.stopTransaction(
    transaction.transactionId,
    payload.meterStop,
    new Date(payload.timestamp),
    mappedReason,
    stopSoc // Pass stopSoC to the database method
  );

  console.log({ updateTXN });

  // Update connector state
  await this.db.updateConnectorStatus(
    chargePointId,
    connectorId,
    "AVAILABLE"
  );

  if (connection.connectors.has(connectorId)) {
    const conn = connection.connectors.get(connectorId)!;
    conn.status = "Available" as any;
    conn.connected = false;
    conn.stopReason = payload.reason ?? null;
    conn.chargingEnergy = payload.meterStop - transaction.meterStart;
    conn.timestamp = new Date();
    connection.connectors.set(connectorId, conn);
  }

  return {
    idTagInfo: {
      status: "Accepted"
    }
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
        // expiryDate: idTagValidation.expiryDate?.toISOString(),
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