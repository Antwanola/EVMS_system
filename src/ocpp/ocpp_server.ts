import * as WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

// Types for OCPP messages
type OcppMessageType = 2 | 3 | 4; // 2=Call, 3=CallResult, 4=CallError
type OcppMessage = [OcppMessageType, string, ...any[]];

const dateOption: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

export class OcppServer {
  private server: WebSocket.Server;
  public chargers: Map<string, WebSocket> = new Map();
  private pendingRequests: Map<string, { action: string, timestamp: number }> = new Map();

  constructor(port: number) {

    this.server = new WebSocket.Server({ port });
    console.log(`OCPP Server started on port ${port}`);
    
    this.init();
  }

  private init() {
    this.server.on('connection', (ws: WebSocket, req) => {
      // Extract charger ID from the URL path (e.g., /ocpp/CP001)
      const urlPath = req.url || '';
      const chargerId = urlPath.split('/').pop();
      
      if (!chargerId) {
        console.error('Charger ID not provided in URL path');
        ws.close();
        return;
      }

      console.log(`Charger ${chargerId} connected`);
      this.chargers.set(chargerId, ws);

      // Handle incoming messages from charger
      ws.on('message', (message: WebSocket.Data) => {
        const msgString = message.toString();
        this.handleMessage(chargerId, msgString);
      });

      // Handle disconnection
      ws.on('close', () => {
        console.log(`Charger ${chargerId} disconnected`);
        this.chargers.delete(chargerId);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`WebSocket error for charger ${chargerId}:`, error);
      });
    });

    // Handle server errors
    this.server.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });

    // Clean up expired requests periodically
    setInterval(() => this.cleanExpiredRequests(), 60000); // Every minute
  }

  private handleMessage(chargerId: string, message: string) {
    try {
      const parsedMessage: OcppMessage = JSON.parse(message);
      console.log(`Received from ${chargerId}:`, parsedMessage);

      const messageTypeId = parsedMessage[0];
      const uniqueId = parsedMessage[1];

      switch (messageTypeId) {
        case 2: // Call from charger
          const action = parsedMessage[2];
          const payload = parsedMessage[3];
          this.handleCall(chargerId, uniqueId, action, payload);
          break;
        case 3: // CallResult from charger (response to our request)
          const resultPayload = parsedMessage[2];
          this.handleCallResult(chargerId, uniqueId, resultPayload);
          break;
        case 4: // CallError from charger
          const errorCode = parsedMessage[2];
          const errorDescription = parsedMessage[3];
          const errorDetails = parsedMessage[4];
          this.handleCallError(chargerId, uniqueId, errorCode, errorDescription, errorDetails);
          break;
        default:
          console.error(`Unknown message type: ${messageTypeId}`);
      }
    } catch (error) {
      console.error(`Error handling message from ${chargerId}:`, error);
    }
  }

  private handleCall(chargerId: string, uniqueId: string, action: string, payload: any) {
    console.log(`Received ${action} from ${chargerId}`);
    
    // Process different OCPP actions
    switch (action) {
      case 'BootNotification':
        this.respondToBootNotification(chargerId, uniqueId, payload);
        break;
      case 'Heartbeat':
        this.respondToHeartbeat(chargerId, uniqueId);
        break;
      case 'StatusNotification':
        this.respondToStatusNotification(chargerId, uniqueId, payload);
        break;
      case 'Authorize':
        this.respondToAuthorize(chargerId, uniqueId, payload);
        break;
      case 'StartTransaction':
        this.respondToStartTransaction(chargerId, uniqueId, payload);
        break;
      case 'StopTransaction':
        this.respondToStopTransaction(chargerId, uniqueId, payload);
        break;
      case 'MeterValues':
        this.respondToMeterValues(chargerId, uniqueId, payload);
        break;
      case 'DiagnosticsStatusNotification':
        this.respondToDiagnosticsStatusNotification(chargerId, uniqueId, payload);
        break;
      case 'FirmwareStatusNotification':
        this.respondToFirmwareStatusNotification(chargerId, uniqueId, payload);
        break;
      case 'DataTransfer':
        this.respondToDataTransfer(chargerId, uniqueId, payload);
        break;
      default:
        console.log(`Unhandled action: ${action}`);
        // Send a generic response
        this.sendCallResult(chargerId, uniqueId, {});
    }
  }

  private handleCallResult(chargerId: string, uniqueId: string, payload: any) {
    const pendingRequest = this.pendingRequests.get(uniqueId);
    if (pendingRequest) {
      console.log(`Received CallResult for ${pendingRequest.action} from ${chargerId}:`, payload);
      this.pendingRequests.delete(uniqueId);
      
      // Here you would typically process the response based on the original action
      // For example, store transaction IDs, update charger status, etc.
      
    } else {
      console.warn(`Received CallResult for unknown request ${uniqueId} from ${chargerId}`);
    }
  }

  private handleCallError(chargerId: string, uniqueId: string, errorCode: string, errorDescription: string, errorDetails: any = {}) {
    const pendingRequest = this.pendingRequests.get(uniqueId);
    if (pendingRequest) {
      console.error(`Received CallError for ${pendingRequest.action} from ${chargerId}: ${errorCode} - ${errorDescription}`, errorDetails);
      this.pendingRequests.delete(uniqueId);
    } else {
      console.warn(`Received CallError for unknown request ${uniqueId} from ${chargerId}`);
    }
  }

  private cleanExpiredRequests() {
    const now = Date.now();
    const expiredIds: string[] = [];
    
    this.pendingRequests.forEach((request, id) => {
      // Consider requests older than 2 minutes as expired
      if (now - request.timestamp > 120000) {
        expiredIds.push(id);
      }
    });
    
    expiredIds.forEach(id => {
      const request = this.pendingRequests.get(id);
      if (request) {
        console.warn(`Request ${id} (${request.action}) expired`);
        this.pendingRequests.delete(id);
      }
    });
  }

  // Helpers to send OCPP messages
  public sendCall(chargerId: string, action: string, payload: any): string {
    const uniqueId = uuidv4();
    const message: OcppMessage = [2, uniqueId, action, payload]; // 2 is the MessageTypeId for Call
    
    this.pendingRequests.set(uniqueId, {
      action,
      timestamp: Date.now()
    });
    
    this.sendToCharger(chargerId, JSON.stringify(message));
    return uniqueId;
  }

  private sendCallResult(chargerId: string, uniqueId: string, payload: any) {
    const message: OcppMessage = [3, uniqueId, payload]; // 3 is the MessageTypeId for CallResult
    this.sendToCharger(chargerId, JSON.stringify(message));
  }

  private sendCallError(chargerId: string, uniqueId: string, errorCode: string, errorDescription: string, errorDetails: any = {}) {
    const message: OcppMessage = [4, uniqueId, errorCode, errorDescription, errorDetails]; // 4 is the MessageTypeId for CallError
    this.sendToCharger(chargerId, JSON.stringify(message));
  }

  private sendToCharger(chargerId: string, message: string) {
    const ws = this.chargers.get(chargerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      console.log(`Sent to ${chargerId}:`, message);
    } else {
      console.error(`Unable to send message to ${chargerId}: connection not open`);
    }
  }

  // OCPP specific response handlers
  private respondToBootNotification(chargerId: string, uniqueId: string, payload: any) {
    console.log(`BootNotification from ${chargerId}:`, payload);
    
    const response = {
      status: 'Accepted', // Can be 'Accepted', 'Pending', or 'Rejected'
      currentTime: new Date().toLocaleDateString('en-us', dateOption),
      interval: 300 // Heartbeat interval in seconds
    };
    this.sendCallResult(chargerId, uniqueId, response);
  }

  private respondToHeartbeat(chargerId: string, uniqueId: string) {
    const response = {
      currentTime: new Date().toLocaleDateString('en-us', dateOption)
    };
    this.sendCallResult(chargerId, uniqueId, response);
  }

  private respondToStatusNotification(chargerId: string, uniqueId: string, payload: any) {
    console.log(`StatusNotification from ${chargerId}:`, payload);
    // Simply acknowledge receipt
    this.sendCallResult(chargerId, uniqueId, {});
  }

  private respondToAuthorize(chargerId: string, uniqueId: string, payload: any) {
    console.log(`Authorize request from ${chargerId} for ID: ${payload.idTag}`);
    
    // In a real implementation, you would validate the idTag against your backend
    const response = {
      idTagInfo: {
        status: 'Accepted' // Can be 'Accepted', 'Blocked', 'Expired', 'Invalid', or 'ConcurrentTx'
      }
    };
    this.sendCallResult(chargerId, uniqueId, response);
  }

  private respondToStartTransaction(chargerId: string, uniqueId: string, payload: any) {
    console.log(`StartTransaction from ${chargerId}:`, payload);
    
    // Generate a transaction ID (in a real implementation, this would be from your database)
    const transactionId = Math.floor(Math.random() * 1000000);
    
    const response = {
      transactionId,
      idTagInfo: {
        status: 'Accepted'
      }
    };
    this.sendCallResult(chargerId, uniqueId, response);
    
    console.log(`Started transaction ${transactionId} for ${chargerId}`);
    return transactionId;
  }

  private respondToStopTransaction(chargerId: string, uniqueId: string, payload: any) {
    console.log(`StopTransaction from ${chargerId}:`, payload);
    
    const response = {
      idTagInfo: {
        status: 'Accepted'
      }
    };
    this.sendCallResult(chargerId, uniqueId, response);
    
    console.log(`Stopped transaction ${payload.transactionId} for ${chargerId}`);
  }

  private respondToMeterValues(chargerId: string, uniqueId: string, payload: any) {
    console.log(`MeterValues from ${chargerId}:`, payload);
    // Process meter values here (store in database, etc.)
    
    // Simply acknowledge receipt
    this.sendCallResult(chargerId, uniqueId, {});
  }

  private respondToDiagnosticsStatusNotification(chargerId: string, uniqueId: string, payload: any) {
    console.log(`DiagnosticsStatusNotification from ${chargerId}:`, payload);
    // Simply acknowledge receipt
    this.sendCallResult(chargerId, uniqueId, {});
  }

  private respondToFirmwareStatusNotification(chargerId: string, uniqueId: string, payload: any) {
    console.log(`FirmwareStatusNotification from ${chargerId}:`, payload);
    // Simply acknowledge receipt
    this.sendCallResult(chargerId, uniqueId, {});
  }

  private respondToDataTransfer(chargerId: string, uniqueId: string, payload: any) {
    console.log(`DataTransfer from ${chargerId}:`, payload);
    
    // In a real implementation, you would process the data transfer based on vendorId and messageId
    const response = {
      status: 'Accepted', // Can be 'Accepted', 'Rejected', or 'UnknownMessageId', or 'UnknownVendorId'
      data: {} // Optional data to return
    };
    this.sendCallResult(chargerId, uniqueId, response);
  }

  // Server-initiated requests (CSMS to Charging Station)
  public remoteStartTransaction(chargerId: string, idTag: string, connectorId: number = 1) {
    const payload = {
      idTag,
      connectorId
      // Optional: chargingProfile
    };
    return this.sendCall(chargerId, 'RemoteStartTransaction', payload);
  }

  public remoteStopTransaction(chargerId: string, transactionId: number) {
    const payload = {
      transactionId
    };
    return this.sendCall(chargerId, 'RemoteStopTransaction', payload);
  }

  public unlockConnector(chargerId: string, connectorId: number = 1) {
    const payload = {
      connectorId
    };
    return this.sendCall(chargerId, 'UnlockConnector', payload);
  }

  public reset(chargerId: string, type: 'Hard' | 'Soft' = 'Soft') {
    const payload = {
      type
    };
    return this.sendCall(chargerId, 'Reset', payload);
  }

  public changeConfiguration(chargerId: string, key: string, value: string) {
    const payload = {
      key,
      value
    };
    return this.sendCall(chargerId, 'ChangeConfiguration', payload);
  }

  public getConfiguration(chargerId: string, keys: string[] = []) {
    const payload = keys.length > 0 ? { key: keys } : {};
    return this.sendCall(chargerId, 'GetConfiguration', payload);
  }

  public triggerMessage(chargerId: string, requestedMessage: string, connectorId: number = 0) {
    const payload = {
      requestedMessage,
      connectorId
    };
    return this.sendCall(chargerId, 'TriggerMessage', payload);
  }

  public sendDiagnosticsRequest(chargerId: string, location: string, retries: number = 0, retryInterval: number = 0) {
    const payload = {
      location,
      retries,
      retryInterval,
      startTime: new Date().toISOString(),
      stopTime: new Date(Date.now() + 3600000).toISOString() // 1 hour from now
    };
    return this.sendCall(chargerId, 'GetDiagnostics', payload);
  }

  public updateFirmware(chargerId: string, location: string, retrieveDate: Date) {
    const payload = {
      location,
      retrieveDate: retrieveDate.toISOString()
    };
    return this.sendCall(chargerId, 'UpdateFirmware', payload);
  }

  public dataTransfer(chargerId: string, vendorId: string, messageId?: string, data?: any) {
    const payload: any = {
      vendorId
    };
    
    if (messageId) payload.messageId = messageId;
    if (data) payload.data = data;
    
    return this.sendCall(chargerId, 'DataTransfer', payload);
  }

  // Server management methods
  public closeConnection(chargerId: string) {
    const ws = this.chargers.get(chargerId);
    if (ws) {
      ws.close();
      this.chargers.delete(chargerId);
      console.log(`Connection to ${chargerId} closed`);
    }
  }

  public shutdown() {
    this.server.close();
    console.log('OCPP Server shut down');
  }
}