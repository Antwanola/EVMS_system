// Helper function to convert OCPP status to internal status
import { ChargePointStatus } from '@/types/ocpp_types';
import { IdTagStatus } from '@prisma/client';
import crypto from "crypto"
export const convertOCPPStatusToInternal = (ocppStatus: string): ChargePointStatus => {
  const statusMap: Record<string, ChargePointStatus> = {
    'Available': 'AVAILABLE',
    'Preparing': 'PREPARING',
    'Charging': 'CHARGING',
    'SuspendedEVSE': 'SUSPENDED_EVSE',
    'SuspendedEV': 'SUSPENDED_EV',
    'Finishing': 'FINISHING',
    'Reserved': 'RESERVED',
    'Unavailable': 'UNAVAILABLE',
    'Faulted': 'FAULTED'
  };
  return statusMap[ocppStatus] || 'UNAVAILABLE';
};

// Helper function to convert internal status to OCPP status
export const convertInternalStatusToOCPP = (internalStatus: ChargePointStatus): string => {
  const statusMap: Record<ChargePointStatus, string> = {
    'AVAILABLE': 'Available',
    'PREPARING': 'Preparing',
    'CHARGING': 'Charging',
    'SUSPENDED_EVSE': 'SuspendedEVSE',
    'SUSPENDED_EV': 'SuspendedEV',
    'FINISHING': 'Finishing',
    'RESERVED': 'Reserved',
    'UNAVAILABLE': 'Unavailable',
    'FAULTED': 'Faulted'
  };
  return statusMap[internalStatus] || 'Unavailable';
};


export  const generateHashedCode = (input: string): string => {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 6).toUpperCase();
  }

export const idTagStatus = (status: IdTagStatus) => {
  const map = {
    ACCEPTED: "Accepted",
    BLOCKED: "Blocked",
    EXPIRED: "Expired",
    INVALID: "Invalid",
    CONCURRENT_TX: "ConcurrentTx"
  } as const;

  return map[status] ?? "Invalid";
}
