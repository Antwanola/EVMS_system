import express from 'express';
import bodyParser from 'body-parser';
import { OcppServer } from './ocpp/ocpp_server';
import http from 'http';



// Create an Express application for the REST API
const app = express();
app.use(bodyParser.json());


export const web_server = http.createServer(app)

// Initialize the OCPP server
const ocppServer = new OcppServer(web_server);

// Define API routes
app.get('/', (req, res) => {
  const chargers = Array.from(ocppServer.chargers.keys());
  res.json({ 
    count: chargers.length,
    chargers: chargers.map(id => ({ id }))
  });
});

app.get('/api/chargers/:chargerId', (req, res) => {
  const { chargerId } = req.params;
  
  if (!ocppServer.chargers.has(chargerId)) {
    return res.status(404).json({ error: `Charger ${chargerId} not found` });
  }
  
  res.json({ 
    id: chargerId,
    connected: true,
    // In a real implementation, you would include more status information
    // from your database or in-memory state
  });
});

app.post('/api/chargers/:chargerId/start', (req, res) => {
  const { chargerId } = req.params;
  const { idTag, connectorId = 1 } = req.body;
  
  if (!ocppServer.chargers.has(chargerId)) {
    return res.status(404).json({ error: `Charger ${chargerId} not found` });
  }
  
  if (!idTag) {
    return res.status(400).json({ error: 'idTag is required' });
  }
  
  try {
    const requestId = ocppServer.remoteStartTransaction(chargerId, idTag, connectorId);
    res.json({ 
      success: true, 
      requestId,
      message: `Start transaction requested for charger ${chargerId}, connector ${connectorId}, with idTag ${idTag}`
    });
  } catch (error) {
    console.error(`Error starting transaction:`, error);
    res.status(500).json({ error: 'Failed to start transaction' });
  }
});

app.post('/api/chargers/:chargerId/stop', (req, res) => {
  const { chargerId } = req.params;
  const { transactionId } = req.body;
  
  if (!ocppServer.chargers.has(chargerId)) {
    return res.status(404).json({ error: `Charger ${chargerId} not found` });
  }
  
  if (!transactionId) {
    return res.status(400).json({ error: 'transactionId is required' });
  }
  
  try {
    const requestId = ocppServer.remoteStopTransaction(chargerId, transactionId);
    res.json({ 
      success: true, 
      requestId,
      message: `Stop transaction ${transactionId} requested for charger ${chargerId}`
    });
  } catch (error) {
    console.error(`Error stopping transaction:`, error);
    res.status(500).json({ error: 'Failed to stop transaction' });
  }
});

app.post('/api/chargers/:chargerId/unlock', (req, res) => {
  const { chargerId } = req.params;
  const { connectorId = 1 } = req.body;
  
  if (!ocppServer.chargers.has(chargerId)) {
    return res.status(404).json({ error: `Charger ${chargerId} not found` });
  }
  
  try {
    const requestId = ocppServer.unlockConnector(chargerId, connectorId);
    res.json({ 
      success: true, 
      requestId,
      message: `Unlock requested for charger ${chargerId}, connector ${connectorId}`
    });
  } catch (error) {
    console.error(`Error unlocking connector:`, error);
    res.status(500).json({ error: 'Failed to unlock connector' });
  }
});

app.post('/api/chargers/:chargerId/reset', (req, res) => {
  const { chargerId } = req.params;
  const { type = 'Soft' } = req.body;
  
  if (!ocppServer.chargers.has(chargerId)) {
    return res.status(404).json({ error: `Charger ${chargerId} not found` });
  }
  
  if (type !== 'Soft' && type !== 'Hard') {
    return res.status(400).json({ error: 'type must be either "Soft" or "Hard"' });
  }
  
  try {
    const requestId = ocppServer.reset(chargerId, type);
    res.json({ 
      success: true, 
      requestId,
      message: `${type} reset requested for charger ${chargerId}`
    });
  } catch (error) {
    console.error(`Error resetting charger:`, error);
    res.status(500).json({ error: 'Failed to reset charger' });
  }
});

app.post('/api/chargers/:chargerId/config', (req, res) => {
  const { chargerId } = req.params;
  const { key, value } = req.body;
  
  if (!ocppServer.chargers.has(chargerId)) {
    return res.status(404).json({ error: `Charger ${chargerId} not found` });
  }
  
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value are required' });
  }
  
  try {
    const requestId = ocppServer.changeConfiguration(chargerId, key, value.toString());
    res.json({ 
      success: true, 
      requestId,
      message: `Configuration change requested for charger ${chargerId}: ${key}=${value}`
    });
  } catch (error) {
    console.error(`Error changing configuration:`, error);
    res.status(500).json({ error: 'Failed to change configuration' });
  }
});

app.get('/api/chargers/:chargerId/config', (req, res) => {
  const { chargerId } = req.params;
  const keys = req.query.keys ? (req.query.keys as string).split(',') : [];
  
  if (!ocppServer.chargers.has(chargerId)) {
    return res.status(404).json({ error: `Charger ${chargerId} not found` });
  }
  
  try {
    const requestId = ocppServer.getConfiguration(chargerId, keys);
    res.json({ 
      success: true, 
      requestId,
      message: `Configuration requested for charger ${chargerId}`
    });
  } catch (error) {
    console.error(`Error getting configuration:`, error);
    res.status(500).json({ error: 'Failed to get configuration' });
  }
});

app.post('/api/chargers/:chargerId/trigger', (req, res) => {
  const { chargerId } = req.params;
  const { requestedMessage, connectorId } = req.body;
  
  if (!ocppServer.chargers.has(chargerId)) {
    return res.status(404).json({ error: `Charger ${chargerId} not found` });
  }
  
  if (!requestedMessage) {
    return res.status(400).json({ error: 'requestedMessage is required' });
  }
  
  try {
    const requestId = ocppServer.triggerMessage(chargerId, requestedMessage, connectorId);
    res.json({ 
      success: true, 
      requestId,
      message: `Trigger message ${requestedMessage} requested for charger ${chargerId}, connector ${connectorId}`
    });
  } catch (error) {
    console.error(`Error triggering message:`, error);
    res.status(500).json({ error: 'Failed to trigger message' });
  }
});

// Start the API server
const PORT = process.env.PORT || 3001;
web_server.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down API and OCPP servers');
  ocppServer.shutdown();
  process.exit(0);
});

export { app, ocppServer };