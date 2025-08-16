# Flow Plan

1. **Station Boot**
   - Station connects via WebSocket
   - Sends `BootNotification`
   - Gateway stores station in database
   - All connectors initialized with `Unknown` status

2. **Connector Status Updates**
   - Station sends `StatusNotification`
   - Gateway updates connector status in DB and Redis cache
   - Dashboard and partner systems receive real-time updates

3. **Meter Data**
   - Station sends `MeterValues`
   - Gateway logs meter reading into database

4. **Transactions**
   - `StartTransaction` → Gateway records start time & meter reading
   - `StopTransaction` → Gateway records end time & calculates total kWh

5. **Control Actions**
   - Admin or partner triggers "Block Connector"
   - Gateway sends `ChangeAvailability` command to station
   - Station updates status
   - Gateway logs the change

6. **Third-Party Access**
   - Partner API allows querying connector availability
   - Real-time WebSocket feed for partner systems
