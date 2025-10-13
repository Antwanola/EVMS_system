// src/types/ocpp.types.ts

export enum MessageType {
  CALL = 2,
  CALLRESULT = 3,
  CALLERROR = 4
}



// Use string literal types to match Prisma schema
export type ChargePointStatus = 
  | 'AVAILABLE'
  | 'PREPARING' 
  | 'CHARGING'
  | 'SUSPENDED_EVSE'
  | 'SUSPENDED_EV'
  | 'FINISHING'
  | 'RESERVED'
  | 'UNAVAILABLE'
  | 'FAULTED';

export type StopReason = 
  | 'EMERGENCY_STOP'
  | 'EV_DISCONNECTED'
  | 'HARD_RESET'
  | 'LOCAL'
  | 'OTHER'
  | 'POWER_LOSS'
  | 'REBOOT'
  | 'REMOTE'
  | 'SOFT_RESET'
  | 'UNLOCK_COMMAND'
  | 'DE_AUTHORIZED'
  | 'ENERGY_LIMIT_REACHED'
  | 'GROUND_FAULT'
  | 'IMMEDIATE_RESET'
  | 'LOCAL_OUT_OF_CREDIT'
  | 'MASTER_PASS'
  | 'OVERCURRENT_FAULT'
  | 'POWER_QUALITY'
  | 'SOC_LIMIT_REACHED'
  | 'STOPPED_BY_EV'
  | 'TIME_LIMIT_REACHED'
  | 'TIMEOUT';

export enum ConnectorType {
  CSS = 'CCS',
  CHAdeMO = 'CHAdeMO',
  TYPE2 = 'TYPE2',
  TYPE1 = 'TYPE1',
  TESLA = 'TESLA',
  GBT = 'GBT'
}


export interface ChargingStationData {
  chargePointId: string;
  connectorId: number;
  gunType: ConnectorType;
  status: ChargePointStatus;
  inputVoltage: number;
  inputCurrent: number;
  outputContactors: boolean;
  outputVoltage: number;
  outputEnergy: number;
  chargingEnergy: number;
  alarm: string | null;
  stopReason: StopReason | null;
  connected: boolean;
  gunTemperature: number;
  stateOfCharge: number;
  chargeTime: number;
  remainingTime: number;
  demandCurrent: number;
  timestamp: Date;
}

export interface OCPPMessage {
  messageTypeId: MessageType;
  uniqueId: string;
  action: string;
  payload: any;
}

export interface MeterValue {
  timestamp: string;
  sampledValue: SampledValue[];
}

export interface SampledValue {
  value: string;
  context?: string;
  format?: string;
  measurand?: string;
  phase?: string;
  location?: string;
  unit?: string;
}

export interface StatusNotificationRequest {
  connectorId: number;
  errorCode: string;
  status: ChargePointStatus;
  info?: string;
  timestamp?: string;
  vendorId?: string;
  vendorErrorCode?: string;
}

export interface MeterValuesRequest {
  connectorId: number;
  transactionId?: number;
  sampledValue: MeterValue[];
}

export interface StartTransactionRequest {
  connectorId: number;
  idTag: string;
  meterStart: number;
  timestamp: string;
  reservationId?: number;
}

export interface StopTransactionRequest {
  transactionId: number;
  timestamp: string;
  meterStop: number;
  reason?: StopReason;
  idTag?: string;
  transactionData?: MeterValue[];
}

export interface BootNotificationRequest {
  chargePointVendor: string;
  chargePointModel: string;
  chargePointSerialNumber?: string;
  chargeBoxSerialNumber?: string;
  firmwareVersion?: string;
  iccid?: string;
  imsi?: string;
  meterType?: string;
  meterSerialNumber?: string;
}

export interface HeartbeatRequest {}

export interface AuthorizeRequest {
  idTag: string;
}

// Response types
export interface BootNotificationResponse {
  status: 'Accepted' | 'Pending' | 'Rejected';
  currentTime: string;
  interval: number;
}

export interface HeartbeatResponse {
  currentTime: string;
}

export interface StatusNotificationResponse {}

export interface MeterValuesResponse {}

export interface StartTransactionResponse {
  transactionId: number;
  idTagInfo: {
    status: 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';
    expiryDate?: string;
    parentIdTag?: string;
  };
}

export interface StopTransactionResponse {
  idTagInfo?: {
    status: 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';
    expiryDate?: string;
    parentIdTag?: string;
  };
}

export interface AuthorizeResponse {
  idTagInfo: {
    status: 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';
    expiryDate?: string;
    parentIdTag?: string;
  };
}

// Central System initiated messages
export interface RemoteStartTransactionRequest {
  connectorId?: number;
  idTag: string;
  chargingProfile?: any;
}

export interface RemoteStopTransactionRequest {
  transactionId: number;
}

export interface ResetRequest {
  type: 'Hard' | 'Soft';
}

export interface UnlockConnectorRequest {
  connectorId: number;
}

export interface GetConfigurationRequest {
  key?: string[];
}

export interface ChangeConfigurationRequest {
  key: string;
  value: string;
}

// WebSocket connection interface
export interface ChargePointConnection {
  id: string;
  ws: any;
  isAlive: boolean;
  lastSeen: Date;
  bootNotificationSent: boolean;
  heartbeatInterval: number;
  currentData?: ChargingStationData | null;
  connectors: Map<number, ChargingStationData>; // Changed from single currentData
  numberOfConnectors?: number; // Track total connectors
  meters?: Map<string, MeterData>; // Meter ID -> Meter readings
  meterConfiguration?: MeterConfiguration;
}
 export interface ConnectorStatus {
  connectorId: number;
  ChargePointId: string;
  status: ChargePointStatus;
  timestamp: Date;
  currentTransactionID?: number;
  meterValue?: MeterValue[];
  errorCode?: string;
  vendorErrorCode?: string;
 }

interface MeterData {
  meterId: string;
  connectorId?: number; // Which connector this meter serves (optional)
  location: 'Inlet' | 'Outlet' | 'EV' | 'Body' | 'Cable';
  measurements: Map<string, MeterMeasurement>; // Measurand -> latest value
  lastUpdated: Date;
}

interface MeterMeasurement {
  measurand: string; // 'Voltage', 'Current.Import', 'Energy.Active.Import.Register', etc.
  value: number;
  unit?: string;
  phase?: 'L1' | 'L2' | 'L3' | 'N';
  location?: 'Inlet' | 'Outlet' | 'EV' | 'Body' | 'Cable';
  context?: 'Interruption.Begin' | 'Interruption.End' | 'Sample.Clock' | 'Sample.Periodic' | 'Transaction.Begin' | 'Transaction.End' | 'Trigger';
  timestamp: Date;
}
// API Gateway interfaces
export interface APIUser {
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer' | 'third_party';
  permissions: string[];
  apiKey?: string;
  chargePointAccess?: string[];
  email?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface MeterConfiguration {
  supportedMeasurands: string[];
  samplingInterval: number;
  meteringPerTransaction: boolean;
}

export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}