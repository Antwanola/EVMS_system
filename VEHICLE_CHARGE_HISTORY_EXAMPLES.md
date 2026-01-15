# Vehicle Charge History - Usage Examples

## Prerequisites
- Authentication token (JWT or API key)
- User with ADMIN or OPERATOR role
- Valid vehicle ID

## Example 1: Get Vehicle Details with Charge Summary

### Request
```http
GET /vehicles/clx123abc456
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Response
```json
{
  "success": true,
  "data": {
    "vehicle": {
      "id": "clx123abc456",
      "make": "Tesla",
      "model": "Model 3",
      "year": 2023,
      "licensePlate": "LAG-123-XY",
      "vin": "5YJ3E1EA1KF123456",
      "batteryCapacityKWh": 75,
      "maxACPowerKW": 11,
      "maxDCPowerKW": 250,
      "vehicleType": "SEDAN",
      "chargingStandards": ["CCS2", "TYPE2_AC"],
      "owner": {
        "id": "user123",
        "username": "john_doe",
        "email": "john@example.com",
        "firstname": "John",
        "lastname": "Doe"
      },
      "fleet": null,
      "status": "Active",
      "isActive": true,
      "createdAt": "2025-12-01T10:00:00Z",
      "updatedAt": "2026-01-15T08:30:00Z"
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

## Example 2: Get Basic Charge History (First Page)

### Request
```http
GET /vehicles/clx123abc456/transactions
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Response
```json
{
  "success": true,
  "data": {
    "vehicle": {
      "id": "clx123abc456",
      "make": "Tesla",
      "model": "Model 3",
      "licensePlate": "LAG-123-XY",
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
        "startSoC": 20,
        "stopSoC": 80,
        "stopReason": "EV_DISCONNECTED",
        "totalAmount": 2500,
        "currency": "NGN",
        "paymentStatus": "COMPLETED",
        "chargePoint": {
          "id": "CP001",
          "name": "Victoria Island Station",
          "location": "Victoria Island, Lagos",
          "vendor": "ABB",
          "model": "Terra 54"
        },
        "connector": {
          "connectorId": 1,
          "type": "CCS2",
          "status": "AVAILABLE"
        },
        "idTag": {
          "idTag": "ABC123DEF",
          "user": {
            "id": "user123",
            "username": "john_doe",
            "email": "john@example.com"
          }
        }
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

## Example 3: Get Charge History with Date Filter

### Request
```http
GET /vehicles/clx123abc456/transactions?startDate=2026-01-01&endDate=2026-01-31&page=1&limit=10
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Use Case
Get all charging sessions for January 2026, showing 10 results per page.

## Example 4: Get Most Expensive Charges First

### Request
```http
GET /vehicles/clx123abc456/transactions?sortBy=totalAmount&sortOrder=desc&limit=5
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Use Case
Find the 5 most expensive charging sessions for this vehicle.

## Example 5: Get Recent Charges (Last 7 Days)

### Request
```javascript
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

const url = `/vehicles/clx123abc456/transactions?startDate=${sevenDaysAgo.toISOString()}&sortBy=startTimestamp&sortOrder=desc`;

fetch(url, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
})
```

## Example 6: Get Longest Charging Sessions

### Request
```http
GET /vehicles/clx123abc456/transactions?sortBy=chargeTime&sortOrder=desc&limit=10
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Use Case
Identify the 10 longest charging sessions to analyze charging patterns.

## Example 7: Pagination Through All Results

### JavaScript Example
```javascript
async function getAllVehicleTransactions(vehicleId, token) {
  const allTransactions = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `/vehicles/${vehicleId}/transactions?page=${page}&limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    const data = await response.json();
    
    if (data.success) {
      allTransactions.push(...data.data.transactions);
      hasMore = page < data.data.pagination.totalPages;
      page++;
    } else {
      hasMore = false;
    }
  }

  return allTransactions;
}
```

## Example 8: Calculate Monthly Charging Costs

### JavaScript Example
```javascript
async function getMonthlyChargingCost(vehicleId, year, month, token) {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  const response = await fetch(
    `/vehicles/${vehicleId}/transactions?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}&limit=100`,
    {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );

  const data = await response.json();
  
  if (data.success) {
    return {
      month: `${year}-${month.toString().padStart(2, '0')}`,
      totalCost: data.data.summary.totalCost,
      totalEnergy: data.data.summary.totalEnergyKWh,
      totalSessions: data.data.summary.totalSessions,
      currency: data.data.summary.currency
    };
  }

  return null;
}

// Usage
const janCost = await getMonthlyChargingCost('clx123abc456', 2026, 1, token);
console.log(`January 2026: ${janCost.totalCost / 100} ${janCost.currency}`);
```

## Example 9: Export to CSV

### JavaScript Example
```javascript
async function exportVehicleTransactionsToCSV(vehicleId, token) {
  const response = await fetch(
    `/vehicles/${vehicleId}/transactions?limit=100`,
    {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );

  const data = await response.json();
  
  if (!data.success) return null;

  const transactions = data.data.transactions;
  
  // CSV headers
  const headers = [
    'Transaction ID',
    'Date',
    'Charge Point',
    'Location',
    'Energy (kWh)',
    'Duration (min)',
    'Cost',
    'Payment Status'
  ];

  // CSV rows
  const rows = transactions.map(txn => {
    const duration = txn.stopTimestamp 
      ? Math.round((new Date(txn.stopTimestamp) - new Date(txn.startTimestamp)) / 60000)
      : 'Ongoing';
    
    const energy = txn.meterStop && txn.meterStart
      ? ((txn.meterStop - txn.meterStart) / 1000).toFixed(2)
      : '0';

    return [
      txn.transactionId,
      new Date(txn.startTimestamp).toLocaleDateString(),
      txn.chargePoint.name,
      txn.chargePoint.location,
      energy,
      duration,
      (txn.totalAmount / 100).toFixed(2),
      txn.paymentStatus
    ];
  });

  // Combine headers and rows
  const csv = [headers, ...rows]
    .map(row => row.join(','))
    .join('\n');

  return csv;
}
```

## Example 10: Dashboard Widget - Charging Statistics

### React Component Example
```javascript
import React, { useEffect, useState } from 'react';

function VehicleChargingStats({ vehicleId, token }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      try {
        const response = await fetch(`/vehicles/${vehicleId}`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        const data = await response.json();
        
        if (data.success) {
          setStats(data.data.transactionSummary);
        }
      } catch (error) {
        console.error('Error fetching stats:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
  }, [vehicleId, token]);

  if (loading) return <div>Loading...</div>;
  if (!stats) return <div>No data available</div>;

  return (
    <div className="charging-stats">
      <h3>Charging Statistics</h3>
      <div className="stat-grid">
        <div className="stat-card">
          <h4>Total Sessions</h4>
          <p>{stats.totalSessions}</p>
        </div>
        <div className="stat-card">
          <h4>Total Energy</h4>
          <p>{stats.totalEnergyKWh.toFixed(2)} kWh</p>
        </div>
        <div className="stat-card">
          <h4>Total Cost</h4>
          <p>{(stats.totalCost / 100).toFixed(2)} {stats.currency}</p>
        </div>
        <div className="stat-card">
          <h4>Active Sessions</h4>
          <p>{stats.activeSessions}</p>
        </div>
      </div>
      {stats.lastChargeDate && (
        <p className="last-charge">
          Last charged: {new Date(stats.lastChargeDate).toLocaleString()}
        </p>
      )}
    </div>
  );
}
```

## Common Use Cases

### 1. Fleet Manager Dashboard
Show charging statistics for all vehicles in a fleet:
```javascript
// Get all vehicles in fleet
GET /fleet/{fleetId}/vehicles

// For each vehicle, get summary
GET /vehicles/{vehicleId}
```

### 2. Billing Report Generation
Generate monthly billing report:
```javascript
GET /vehicles/{vehicleId}/transactions?startDate=2026-01-01&endDate=2026-01-31&limit=100
```

### 3. Energy Consumption Analysis
Analyze energy consumption patterns:
```javascript
GET /vehicles/{vehicleId}/transactions?sortBy=energyConsumed&sortOrder=desc
```

### 4. Payment Reconciliation
Find unpaid transactions:
```javascript
// Note: Would need additional filtering support
GET /vehicles/{vehicleId}/transactions
// Then filter client-side for paymentStatus === 'PENDING'
```

### 5. Vehicle Maintenance Planning
Track charging frequency to plan maintenance:
```javascript
GET /vehicles/{vehicleId}/transactions?sortBy=startTimestamp&sortOrder=desc&limit=50
```

## Error Handling

### Invalid Vehicle ID
```json
{
  "success": false,
  "error": "Vehicle not found"
}
```

### Unauthorized Access
```json
{
  "success": false,
  "error": "Insufficient permissions"
}
```

### Invalid Date Format
```json
{
  "success": false,
  "error": "Invalid date format. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)"
}
```

## Tips and Best Practices

1. **Use Pagination**: Always use pagination for large datasets to improve performance
2. **Cache Results**: Cache frequently accessed data (e.g., monthly summaries)
3. **Date Ranges**: Use specific date ranges to reduce query size
4. **Limit Results**: Use appropriate limit values (default: 20, max: 100)
5. **Sort Wisely**: Sort by indexed fields (startTimestamp) for better performance
6. **Handle Errors**: Always check the `success` field in responses
7. **Token Refresh**: Implement token refresh logic for long-running operations
8. **Rate Limiting**: Respect API rate limits when making multiple requests

## Performance Optimization

1. **Batch Requests**: When fetching data for multiple vehicles, batch requests
2. **Incremental Loading**: Load data incrementally as user scrolls
3. **Background Sync**: Sync data in background for offline access
4. **Caching Strategy**: Cache transaction summaries, refresh periodically
5. **Compression**: Enable gzip compression for large responses
