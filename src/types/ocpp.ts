// Message types according to OCPP 1.6 spec
export type OCPPMessageType = 2 | 3 | 4;

export type OCPPCallMessage = [2, string, OCPPAction, any];
export type OCPPCallResultMessage = [3, string, any];
export type OCPPCallErrorMessage = [4, string, string, string?, object?];

export type OCPPMessage = OCPPCallMessage | OCPPCallResultMessage | OCPPCallErrorMessage;

export type OCPPAction =
  | 'BootNotification'
  | 'Authorize'
  | 'Heartbeat'
  | 'StartTransaction'
  | 'StopTransaction'
  | 'MeterValues'
  | 'StatusNotification'
  | 'DataTransfer'
  | 'FirmwareStatusNotification'
  | 'DiagnosticsStatusNotification'
  | 'ChangeConfiguration'
  | 'Reset'
  | string; // catch-all for extension/custom messages

// Example payload types

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

export interface BootNotificationResponse {
  currentTime: string;  // ISO date string
  interval: number;     // Heartbeat interval in seconds
  status: 'Accepted' | 'Pending' | 'Rejected';
}
