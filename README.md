# OCPP Server for WebSocket-based EV Chargers

This is a TypeScript Node.js implementation of an OCPP (Open Charge Point Protocol) server that can communicate with WebSocket-based EV chargers. The server supports receiving signals from chargers and sending responses/commands back to them.

## Features

- WebSocket-based OCPP 1.6/2.0.1 communication
- Support for receiving and processing charger messages
- Support for sending commands to chargers
- RESTful API for controlling chargers through HTTP requests
- Test client simulating an OCPP-compatible charger for testing

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

## Usage

### Starting the OCPP Server

```bash
npm start
```

This will start the OCPP server on port 9220 (default OCPP port).

### Starting the API Server

```bash
npm run api
```

This will start the API server on port 3000.

### Running the Test Client

```bash
ts-node test-client.ts [CHARGER_ID] [SERVER_URL]
```

Example:
```bash
ts-node test-client.ts CP001 ws://localhost:9220
```

## API Endpoints

The API server provides the following endpoints for controlling chargers:

### GET /api/chargers
List all connected chargers

### GET /api/chargers/:chargerId
Get information about a specific charger

### POST /api/chargers/:chargerId/start
Start a transaction on a charger
- Request body: `{ "idTag": "TAG123", "connectorId": 1 }`

### POST /api/chargers/:chargerId/stop
Stop a transaction on a charger
- Request body: `{ "transactionId": 12345 }`

### POST /api/chargers/:chargerId/unlock
Unlock a connector on a charger
- Request body: `{ "connectorId": 1 }`

### POST /api/chargers/:chargerId/reset
Reset a charger
- Request body: `{ "type": "Soft" }` (can be "Soft" or "Hard")

### POST /api/chargers/:chargerId/config
Change configuration on a charger
- Request body: `{ "key": "HeartbeatInterval", "value": "300" }`

### GET /api/chargers/:chargerId/config
Get configuration from