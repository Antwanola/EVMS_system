# Vehicle Charge History - Quick Reference

## Endpoints

### Get Vehicle with Summary
```
GET /vehicles/:id
Authorization: Bearer {token}
```

### Get Charge History
```
GET /vehicles/:id/transactions?page=1&limit=20&startDate=2026-01-01&endDate=2026-01-31
Authorization: Bearer {token}
```

## Query Parameters

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| page | number | 1 | - | Page number |
| limit | number | 20 | 100 | Results per page |
| startDate | ISO 8601 | - | - | Filter from date |
| endDate | ISO 8601 | - | - | Filter to date |
| sortBy | string | startTimestamp | - | Sort field |
| sortOrder | asc/desc | desc | - | Sort direction |

## Response Fields

### Transaction Summary
```json
{
  "totalSessions": 45,
  "completedSessions": 43,
  "activeSessions": 2,
  "totalEnergyKWh": 1250.5,
  "totalCost": 125000,
  "currency": "NGN",
  "lastChargeDate": "2026-01-15T10:30:00Z",
  "averageSessionDuration": 90
}
```

### Transaction Object
```json
{
  "transactionId": 123456,
  "startTimestamp": "2026-01-15T10:00:00Z",
  "stopTimestamp": "2026-01-15T11:30:00Z",
  "meterStart": 50000,
  "meterStop": 75000,
  "energyConsumed": 25,
  "startSoC": 20,
  "stopSoC": 80,
  "totalAmount": 2500,
  "currency": "NGN",
  "paymentStatus": "COMPLETED"
}
```

## Common Queries

### Last 30 Days
```javascript
const thirtyDaysAgo = new Date();
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
const url = `/vehicles/${id}/transactions?startDate=${thirtyDaysAgo.toISOString()}`;
```

### Most Expensive First
```
GET /vehicles/:id/transactions?sortBy=totalAmount&sortOrder=desc
```

### This Month
```javascript
const now = new Date();
const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
const url = `/vehicles/${id}/transactions?startDate=${startOfMonth.toISOString()}`;
```

## Error Codes

| Code | Message | Cause |
|------|---------|-------|
| 400 | Vehicle ID is required | Missing vehicle ID |
| 404 | Vehicle not found | Invalid vehicle ID |
| 401 | Authentication required | Missing/invalid token |
| 403 | Insufficient permissions | Wrong role |
| 500 | Failed to fetch | Server error |

## Units

- **Energy**: kWh (kilowatt-hours)
- **Power**: kW (kilowatts)
- **Currency**: Smallest unit (kobo for NGN)
- **Duration**: Minutes
- **Timestamps**: ISO 8601 UTC

## Conversion Examples

```javascript
// Wh to kWh
const kWh = wattHours / 1000;

// Kobo to Naira
const naira = kobo / 100;

// Duration in milliseconds to minutes
const minutes = milliseconds / 1000 / 60;

// ISO string to Date
const date = new Date(isoString);
```

## Authentication

### JWT Token
```javascript
headers: {
  'Authorization': `Bearer ${jwtToken}`
}
```

### API Key
```javascript
headers: {
  'x-api-key': apiKey
}
```

## Required Roles
- ADMIN
- OPERATOR

## Files Modified
- `src/services/api_gateway.ts` - API endpoints
- `src/services/database.ts` - Database queries

## Database Method
```typescript
db.getVehicleTransactions(vehicleId, {
  skip: 0,
  take: 20,
  startDate: new Date('2026-01-01'),
  endDate: new Date('2026-01-31'),
  sortBy: 'startTimestamp',
  sortOrder: 'desc'
})
```

## Quick Test

```bash
# Get vehicle summary
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/vehicles/VEHICLE_ID

# Get charge history
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:3000/vehicles/VEHICLE_ID/transactions?page=1&limit=10"
```

## Performance Tips

1. Use pagination (limit ≤ 100)
2. Filter by date range
3. Cache frequently accessed data
4. Use indexed fields for sorting
5. Batch requests when possible

## Related Endpoints

- `GET /vehicles` - List all vehicles
- `POST /create-vehicles` - Create vehicle
- `PUT /vehicles/:id` - Update vehicle
- `DELETE /vehicles/:id` - Delete vehicle
- `GET /fleet/:id/vehicles` - Fleet vehicles
- `GET /transactions` - All transactions

---

**Quick Links:**
- [Full API Documentation](./VEHICLE_CHARGE_HISTORY_API.md)
- [Usage Examples](./VEHICLE_CHARGE_HISTORY_EXAMPLES.md)
- [Implementation Details](./IMPLEMENTATION_SUMMARY.md)
