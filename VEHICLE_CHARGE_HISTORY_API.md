# Vehicle Charge History API

## Overview
This document describes the vehicle charge history endpoints that allow you to retrieve charging transaction history for vehicles.

## Endpoints

### 1. Get Vehicle by ID (Enhanced with Transaction Summary)
**Endpoint:** `GET /vehicles/:id`

**Authentication:** Required (ADMIN or OPERATOR role)

**Description:** Retrieves a single vehicle with all its details and a transaction summary.

**Response:**
```json
{
  "success": true,
  "data": {
    "vehicle": {
      "id": "vehicle-id",
      "make": "Tesla",
      "model": "Model 3",
      "licensePlate": "ABC123",
      "vin": "5YJ3E1EA1KF123456",
      "batteryCapacityKWh": 75,
      "owner": { ... },
      "fleet": { ... },
      "transactions": [ ... ]
    },
    "transactionSummary": {
      "totalSessions": 45,
      "completedSessions": 43,
      "activeSessions": 2,
      "totalEnergyKWh": 1250.5,
      "totalCost": 125000,
      "currency": "NGN",
      "lastChargeDate": "2026-01-15T10:30:00Z"
    }
  }
}
```

### 2. Get Vehicle Charge History
**Endpoint:** `GET /vehicles/:id/transactions`

**Authentication:** Required (ADMIN or OPERATOR role)

**Description:** Retrieves paginated charging transaction history for a specific vehicle with filtering and sorting options.

**Query Parameters:**
- `page` (optional, default: 1) - Page number for pagination
- `limit` (optional, default: 20, max: 100) - Number of transactions per page
- `startDate` (optional) - Filter transactions from this date (ISO 8601 format)
- `endDate` (optional) - Filter transactions until this date (ISO 8601 format)
- `sortBy` (optional, default: 'startTimestamp') - Field to sort by
- `sortOrder` (optional, default: 'desc') - Sort order ('asc' or 'desc')

**Example Request:**
```
GET /vehicles/clx123abc/transactions?page=1&limit=20&startDate=2026-01-01&endDate=2026-01-31&sortBy=startTimestamp&sortOrder=desc
```

**Response:**
```json
{
  "success": true,
  "data": {
    "vehicle": {
      "id": "clx123abc",
      "make": "Tesla",
      "model": "Model 3",
      "licensePlate": "ABC123",
      "vin": "5YJ3E1EA1KF123456"
    },
    "transactions": [
      {
        "id": 1,
        "transactionId": 123456,
        "chargePointId": "CP001",
        "connectorId": 1,
        "startTimestamp": "2026-01-15T10:00:00Z",
        "stopTimestamp": "2026-01-15T11:30:00Z",
        "meterStart": 50000,
        "meterStop": 75000,
        "energyConsumed": 25,
        "totalAmount": 2500,
        "currency": "NGN",
        "paymentStatus": "COMPLETED",
        "startSoC": 20,
        "stopSoC": 80,
        "chargePoint": {
          "id": "CP001",
          "name": "Station A",
          "location": "Lagos",
          "vendor": "ABB",
          "model": "Terra 54"
        },
        "connector": {
          "connectorId": 1,
          "type": "CCS2",
          "status": "AVAILABLE"
        },
        "idTag": {
          "idTag": "ABC123",
          "user": {
            "id": "user-id",
            "username": "john_doe",
            "email": "john@example.com"
          }
        },
        "meterValues": [ ... ]
      }
    ],
    "summary": {
      "totalSessions": 45,
      "totalEnergyKWh": 1250.5,
      "totalCost": 125000,
      "completedSessions": 43,
      "activeSessions": 2,
      "averageSessionDuration": 90,
      "currency": "NGN"
    },
    "pagination": {
      "total": 45,
      "page": 1,
      "limit": 20,
      "totalPages": 3
    }
  }
}
```

## Transaction Fields Explained

- **transactionId**: Unique OCPP transaction identifier
- **meterStart/meterStop**: Energy meter readings in Wh (Watt-hours)
- **energyConsumed**: Calculated energy consumed in kWh
- **startSoC/stopSoC**: State of Charge percentage at start and stop
- **totalAmount**: Total cost of the transaction in the smallest currency unit (e.g., kobo for NGN)
- **paymentStatus**: Payment status (PENDING, COMPLETED, FAILED, etc.)
- **averageSessionDuration**: Average session duration in minutes

## Use Cases

1. **Vehicle Owner Dashboard**: Display charging history and statistics for a vehicle
2. **Fleet Management**: Monitor charging patterns across fleet vehicles
3. **Billing Reports**: Generate detailed billing reports for vehicle charging
4. **Energy Analytics**: Analyze energy consumption patterns over time
5. **Maintenance Planning**: Track charging frequency and battery health indicators

## Error Responses

**400 Bad Request:**
```json
{
  "success": false,
  "error": "Vehicle ID is required"
}
```

**404 Not Found:**
```json
{
  "success": false,
  "error": "Vehicle not found"
}
```

**500 Internal Server Error:**
```json
{
  "success": false,
  "error": "Failed to fetch vehicle transactions"
}
```

## Notes

- All timestamps are in ISO 8601 format (UTC)
- Energy values are converted from Wh to kWh for better readability
- Transactions are ordered by start timestamp (most recent first) by default
- The endpoint includes both completed and active (ongoing) transactions
- Meter values include detailed charging data sampled during the session
