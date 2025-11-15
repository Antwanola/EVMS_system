evms-central-system/
├── src/
│   ├── server.ts              # WebSocket server
│   ├── ocpp/
│   │   ├── router.ts          # Handle OCPP actions
│   │   └── messages.ts        # OCPP message parsing
│   ├── db/
│   │   └── mongo.ts           # MongoDB connection
│   └── types/
│       └── ocpp.ts            # Type definitions for OCPP messages
├── tsconfig.json
├── Docker/
│   ├── Dockerfile             # Defines container build for OCPP server
│   ├── docker-compose.yml     # Compose file to run app + MongoDB
│   ├── start_ocpp.sh          # Script to start server inside container
│   └── deploy_ocpp.sh         # Deployment helper script


****************************************************************************************
#User table
interface User {
  id: string; // UUID
  name: string;
  email: string;
  phone?: string;
  idTag: string; // Unique identifier used in OCPP
  status: 'Active' | 'Blocked' | 'Expired';
  expiryDate?: Date;
  createdAt: Date;
}

**************************************************************************
interface ChargePoint {
  id: string; // UUID
  vendor: string;
  model: string;
  serialNumber: string;
  firmwareVersion?: string;
  status: 'Available' | 'Occupied' | 'Faulted' | 'Unavailable';
  lastHeartbeat?: Date;
  location: {
    latitude: number;
    longitude: number;
    address: string;
  };
  createdAt: Date;
}



************************************************
interface Connector {
  id: string; // UUID
  chargePointId: string;
  connectorId: number; // As per OCPP
  status: 'Available' | 'Charging' | 'Faulted' | 'Reserved';
  type: 'Type1' | 'Type2' | 'CCS' | 'CHAdeMO';
  maxPowerKw: number;
}

*******************************************************************
interface Transaction {
  id: string; // UUID
  chargePointId: string;
  connectorId: number;
  userId: string;
  idTag: string;
  meterStart: number;
  meterStop?: number;
  timestampStart: Date;
  timestampStop?: Date;
  status: 'Started' | 'Stopped' | 'Error';
}
*********************************************************************

interface AuthorizationLog {
  id: string;
  chargePointId: string;
  idTag: string;
  status: 'Accepted' | 'Blocked' | 'Expired' | 'Invalid';
  timestamp: Date;
}
**********************************************************************

interface RemoteCommand {
  id: string;
  type: 'RemoteStartTransaction' | 'RemoteStopTransaction';
  chargePointId: string;
  connectorId?: number;
  idTag: string;
  status: 'Pending' | 'Accepted' | 'Rejected' | 'Failed';
  issuedAt: Date;
  resolvedAt?: Date;
}

*********************************************************************

interface MeterValue {
  id: string;
  transactionId: string;
  timestamp: Date;
  value: number; // in Wh
  context: 'Sample.Periodic' | 'Transaction.Begin' | 'Transaction.End';
}

************************************************************************

interface Heartbeat {
  id: string;
  chargePointId: string;
  timestamp: Date;
}


************************************************************************

interface FirmwareUpdate {
  id: string;
  chargePointId: string;
  version: string;
  status: 'Pending' | 'Downloading' | 'Installed' | 'Failed';
  requestedAt: Date;
  completedAt?: Date;
}