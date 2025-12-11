import { IdTag, IdTagStatus } from '@prisma/client';
// src/services/api-gateway.ts
import { Router, Request, Response, NextFunction } from 'express';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Joi from 'joi';
import { Logger } from '../Utils/logger';
import { OCPPServer } from '../services/ocpp_server';
import { DatabaseService } from '../services/database';
import { RedisService } from '../services/redis';
import { APIResponse, APIUser, ChargingStationData } from '../types/ocpp_types';
import { TransactionQueryParams } from '../types/TnxQueryType';
import crypto from 'crypto';
import { UserStrutcture } from '../types/apiHelperypes';
import { generateHashedCode, idTagStatus } from '../helpers/helper';


interface AuthenticatedRequest extends Request {
  user?: APIUser;
}

export class APIGateway {
  private router: Router;
  private logger = Logger.getInstance();
  private rateLimiter?: RateLimiterRedis;
 public clients: Map<Response, { connectorId?: number }> = new Map();

  constructor(
    private ocppServer: OCPPServer | null,
    private db: DatabaseService,
    private redis?: RedisService
  ) {
    this.router = Router();
    // this.setupRateLimiter();
    this.setupRoutes();
    this.ocppServer = ocppServer;
  }

  // Safe setter to fix circular dependency
  public setOcppServer(ocppServer: OCPPServer): void {
    this.ocppServer = ocppServer;
  }

  private setupRateLimiter(): void {
    if (this.redis) {
      this.rateLimiter = new RateLimiterRedis({
        storeClient: this.redis.getClient(),
        points: parseInt(process.env.RATE_LIMIT_POINTS || '100'),
        duration: parseInt(process.env.RATE_LIMIT_DURATION || '60'),
      });
    }
  }




  private setupRoutes(): void {
    // Apply rate limiting middleware
    this.router.use(this.rateLimitMiddleware.bind(this));

    // Authentication routes
    this.router.post('/auth/login', this.login.bind(this));
    this.router.post('/auth/register', this.register.bind(this));
    this.router.post('/auth/refresh', this.refreshToken.bind(this));
    
    // Charge point routes
    this.router.get('/charge-points', this.authenticateUser.bind(this), this.getChargePoints.bind(this));
    this.router.get('/charge-points/:id', this.authenticateUser.bind(this), this.getChargePoint.bind(this));
    this.router.get('/charge-points/:id/data', this.authenticateUser.bind(this), this.getChargePointData.bind(this));
    this.router.get('/charge-points/:id/history', this.authenticateUser.bind(this), this.getChargePointHistory.bind(this));
    this.router.get('/charge-points/:id/status', this.authenticateUser.bind(this), this.getChargePointStatus.bind(this));
    this.router.get('/charge-points/:id/connectors', this.authenticateUser.bind(this), this.getChargePointConnectors.bind(this));
    this.router.post('/charge-points/:id/message', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.sendMessage.bind(this));

    // Real-time data routes
    this.router.get('/realtime/all', this.authenticateUser.bind(this), this.getAllRealtimeData.bind(this));
    this.router.get('/realtime/:chargePointId', this.authenticateUser.bind(this), this.getRealtimeData.bind(this));

    // Transaction routes
    this.router.get('/transactions', this.authenticateUser.bind(this), this.getTransactions.bind(this));
    this.router.get('/transactions/:id', this.authenticateUser.bind(this), this.getTransaction.bind(this));
    this.router.get('/transactions/active', this.authenticateUser.bind(this), this.getActiveTransactions.bind(this));

    // Control routes (requires higher permissions)
    this.router.post('/charge-points/remote-start/:chargePointId/:connectorId', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.remoteStartTransaction.bind(this));
    this.router.post('/charge-points/remote-stop/:chargePointId/:transactionId', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.remoteStopTransaction.bind(this));
    this.router.post('/charge-points/:id/reset', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.resetChargePoint.bind(this));
    this.router.post('/charge-points/:id/unlock', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.unlockConnector.bind(this));

    // Configuration routes
    this.router.get('/charge-points/:id/configuration', this.authenticateUser.bind(this), this.getConfiguration.bind(this));
    this.router.post('/charge-points/:id/configuration', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.changeConfiguration.bind(this));
    this.router.get('/stream-metervalues', this.authenticateUser.bind(this), this.streamMeterValues.bind(this));

    // Alarm routes
    this.router.get('/alarms', this.authenticateUser.bind(this), this.getAlarms.bind(this));
    this.router.post('/alarms/:id/resolve', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.resolveAlarm.bind(this));

    // Analytics routes
    this.router.get('/analytics/statistics', this.authenticateUser.bind(this), this.getStatistics.bind(this));
    this.router.get('/analytics/energy-consumption', this.authenticateUser.bind(this), this.getEnergyConsumption.bind(this));

    // User management routes (Admin only)
    this.router.get('/users/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']),this.getOneUser.bind(this));
    this.router.get('/users', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.getUsers.bind(this));
    this.router.post('/create-users', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.createUser.bind(this));
    this.router.post('/users/update', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.editUser.bind(this))
    this.router.delete('/users/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.deleteUser.bind(this));

    // Health check
    this.router.get('/health', this.healthCheck.bind(this));
  }

  // Middleware
  private async rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!this.rateLimiter) {
      return next();
    }

    try {
      await this.rateLimiter.consume(req.ip || 'anonymous');
      next();
    } catch (rateLimiterRes) {
      this.sendErrorResponse(res, 429, 'Too Many Requests');
    }
  }

  private async authenticateUser(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;

      if (!token) {
        this.sendErrorResponse(res, 401, 'Authentication required');
        return;
      }

      let user: any = null;

      // Try JWT token first
      if (token.startsWith('eyJ')) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
          user = await this.db.getUserByEmail(decoded.email);
        } catch (error) {
          // Invalid JWT, continue to API key check
        }
      }

      // Try API key
      if (!user) {
        user = await this.db.getUserByApiKey(token);
      }

      if (!user || !user.isActive) {
        this.sendErrorResponse(res, 401, 'Invalid authentication credentials');
        return;
      }

      req.user = user;
      next();
    } catch (error) {
      this.logger.error('Authentication error:', error);
      this.sendErrorResponse(res, 500, 'Authentication failed');
    }
  }

  private requireRole(roles: string[]) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (!req.user || !roles.includes(req.user.role)) {
        this.sendErrorResponse(res, 403, 'Insufficient permissions');
        return;
      }
      next();
    };
  }

  // Authentication endpoints
  private async login(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      email: Joi.string().required(),
      password: Joi.string().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      this.sendErrorResponse(res, 400, error.details[0].message);
      return;
    }

    try {
      const user = await this.db.getUserByEmail(value.email);
      console.log(user);

      if (!user || !user.isActive) {
        this.sendErrorResponse(res, 401, 'Invalid credentials');
        return;
      }

      const isPasswordValid = await bcrypt.compare(value.password, user.password);
      console.log(isPasswordValid);
      if (!isPasswordValid) {
        this.sendErrorResponse(res, 401, 'Invalid credentials');
        return;
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role, username: user.username },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      );

      this.sendSuccessResponse(res, {
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          permissions: user?.permissions,
        },
      });
    } catch (error) {
      this.logger.error('Login error:', error);
      this.sendErrorResponse(res, 500, 'Login failed');
    }
  }

  private async register(req: Request, res: Response): Promise<void> {
    const schema = Joi.object({
      username: Joi.string().min(3).max(30).required(),
      email: Joi.string().email().required(),
      password: Joi.string().min(6).required(),
      role: Joi.string().valid('ADMIN', 'OPERATOR', 'VIEWER', 'THIRD_PARTY').default('VIEWER'),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      this.sendErrorResponse(res, 400, error.details[0].message);
      return;
    }

    try {
      const hashedPassword = await bcrypt.hash(value.password, 12);
      const idTag = generateHashedCode(value.email + Date.now().toString())
      const data = {
         idTag: idTag,
      parentIdTag: undefined,
      status: (IdTagStatus.ACCEPTED),
      expiryDate: undefined
      }
      const createTag = await this.db.createIdTag(data)
      if(!createTag) {
        this.sendErrorResponse(res, 404, "unable to create idTag")
        return
      }

      const user = await this.db.createUser({
        username: value.username,
        email: value.email,
        password: hashedPassword,
        idTags: createTag.idTag,
        role: value.role,
      });

      this.sendSuccessResponse(res, {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      });
    } catch (error: any) {
      this.logger.error('Registration error:', error);
      if (error.code === 'P2002') {
        this.sendErrorResponse(res, 409, 'Username or email already exists');
        return;
      }
      this.sendErrorResponse(res, 500, 'Registration failed');
    }
  }

  private async refreshToken(req: Request, res: Response): Promise<void> {
    // Implementation for token refresh
    this.sendSuccessResponse(res, { message: 'Token refresh endpoint' });
  }


  private async getOneUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      if(!id) return

      const user = await this.db.getUserById(id);
      if(!user){
        this.sendErrorResponse(res, 404, 'User not found');
      }
      this.sendSuccessResponse(res, { message: 'User fetched successfully', user});
    } catch (error) {
      this.logger.error('Error fetching user:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch user');
    }
  }


  
private async editUser(req: AuthenticatedRequest, res: Response): Promise<void> {
  const schema = Joi.object({
    id: Joi.string().optional(),
    username: Joi.string().min(3).max(30).optional(),
    firstname: Joi.string().min(3).max(40).optional(),
    lastname: Joi.string().min(3).max(40).optional(),
    status: Joi.string().optional(),
    email: Joi.string().email().required(),
    password: Joi.string().min(6).optional(),
    role: Joi.string().valid('ADMIN', 'OPERATOR', 'VIEWER', 'THIRD_PARTY').optional(),
    isActive: Joi.boolean().optional(),
    apiKey: Joi.string().optional(),
    phone: Joi.string().optional(),
    idTag: Joi.string().optional(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    this.sendErrorResponse(res, 400, error.details[0].message);
    return;
  }

  try {
    // Get existing user first
    const user = await this.db.getUserByEmail(value.email);

    if (!user) {
      this.sendErrorResponse(res, 404, 'User not found');
      return;
    }

    // Build update data object with only provided fields
    const data: Partial<UserStrutcture> = {};

    // Only add fields that were provided in the request
    if (value.username !== undefined) data.username = value.username;
    if (value.firstname !== undefined) data.firstname = value.firstname;
    if (value.lastname !== undefined) data.lastname = value.lastname;
    if (value.email !== undefined) data.email = value.email;
    if (value.isActive !== undefined) data.isActive = value.isActive;
    if (value.status !== undefined) data.status = value.status;
    if (value.phone !== undefined) data.phone = value.phone;
    if (value.role !== undefined) data.role = value.role;

    // Handle password hashing if provided
    if (value.password) {
      const hashedPassword = await bcrypt.hash(value.password, 12);
      data.password = hashedPassword;
    }

    // Generate idTag if it doesn't exist
    // Cast user to any to bypass type checking for idTag property
    const userWithIdTag = user as any;
    if (!userWithIdTag.idTag) {
      data.idTag = generateHashedCode(user.email + Date.now().toString());
    }

    console.log("edit user data:", data);

    // Update user in database
    const updatedUser = await this.db.updateUser(value.email, data);
    
    if (!updatedUser) {
      throw new Error('Unable to update user');
    }

    // Cast updatedUser to any to bypass type checking for idTag property
    const updatedUserWithIdTag = updatedUser as any;

    // Return updated user data (excluding sensitive fields)
    this.sendSuccessResponse(res, {
      id: updatedUser.id,
      email: updatedUser.email,
      username: updatedUser.username,
      firstname: updatedUser.firstname,
      lastname: updatedUser.lastname,
      isActive: updatedUser.isActive,
      status: updatedUser.status,
      phone: updatedUser.phone,
      role: updatedUser.role,
      idTag: updatedUserWithIdTag.idTag || updatedUserWithIdTag.idTags || null,
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt,
    });
  } catch (error) {
    this.logger.error('Edit user error:', error);
    this.sendErrorResponse(res, 500, 'Failed to edit user');
  }
}

// Store clients with their connector filter
// private clients: Map<Response, { connectorId?: number }> = new Map();

public async streamMeterValues(req: AuthenticatedRequest, res: Response): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Get connector ID from query parameter
  const connectorId = req.query.connectorId 
    ? parseInt(req.query.connectorId as string) 
    : undefined;

  // Store client with their connector filter
  this.clients.set(res, { connectorId });
  console.log("Connected clients:", this.clients.size);

  // Send initial connection confirmation (optional)
  res.write(`data: ${JSON.stringify({ type: 'connected', connectorId })}\n\n`);

  req.on("close", () => {
    this.clients.delete(res);
    console.log("Client disconnected. Remaining clients:", this.clients.size);
  });

  // Don't call sendMeterValueToClients here - it should be called 
  // when you actually receive meter values from the charging station
}

// This should be called when you receive meter values from OCPP messages
public sendMeterValueToClients = (data: any): void => {
  const connectorId = data.connectorId || data.connector_id;
  
  console.log(`Broadcasting meter value for connector ${connectorId} to ${this.clients.size} clients`);
  
  for (const [client, filter] of this.clients.entries()) {
    try {
      // If client has a connector filter, only send matching data
      if (filter.connectorId !== undefined && filter.connectorId !== connectorId) {
        continue;
      }
      
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      this.logger.error('Error sending meter value to client:', error);
      // Remove failed client
      this.clients.delete(client);
    }
  }
}
  // Charge point endpoints
  private async getChargePoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const chargePoints = await this.db.getAllChargePoints();
      const connectedIds = this.ocppServer.getConnectedChargePoints();
      const enrichedChargePoints = chargePoints.map(cp => ({
        chargePoint: cp,
        isConnected: connectedIds.includes(cp.id),
        realTimeData: this.ocppServer!.getChargePointData(cp.id),
      }));

      this.sendSuccessResponse(res, enrichedChargePoints);
    } catch (error) {
      this.logger.error('Error fetching charge points:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch charge points');
    }
  }

  private async getChargePoint(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const chargePoint = await this.db.getChargePoint(id);

      if (!chargePoint) {
        this.sendErrorResponse(res, 404, 'Charge point not found');
        return;
      }

      const isConnected = this.ocppServer.getConnectedChargePoints().includes(id);
      const realTimeData = this.ocppServer.getChargePointData(id);

      this.sendSuccessResponse(res, {
        chargePoint,
        isConnected,
        realTimeData,
      });
    } catch (error) {
      this.logger.error('Error fetching charge point:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch charge point');
    }
  }

  private async getChargePointData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const data = this.ocppServer.getChargePointData(id);

      if (!data) {
        this.sendErrorResponse(res, 404, 'Charge point not connected or no data available');
        return;
      }

      this.sendSuccessResponse(res, data);
    } catch (error) {
      this.logger.error('Error fetching charge point data:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch charge point data');
    }
  }

  private async getChargePointHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { startDate, endDate, limit = '1000', connectorId } = req.query;

      const history = await this.db.getChargingDataHistory(
        id,
        connectorId ? parseInt(connectorId as string) : undefined,
        startDate ? new Date(startDate as string) : undefined,
        endDate ? new Date(endDate as string) : undefined,
        parseInt(limit as string)
      );

      this.sendSuccessResponse(res, history);
    } catch (error) {
      this.logger.error('Error fetching charge point history:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch charge point history');
    }
  }

 private async getChargePointStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!this.ocppServer) {
      this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
      return;
    }

    const { id } = req.params;
    const isConnected = this.ocppServer.getConnectedChargePoints().includes(id);
    const data = this.ocppServer.getChargePointData(id); // This now returns ChargingStationData[]

    // Helper function to get overall status from all connectors
    const getOverallStatus = (connectors: ChargingStationData[] | null): string => {
      if (!connectors || connectors.length === 0) return 'UNAVAILABLE';
      
      // Priority: Charging > Preparing > SuspendedEV > SuspendedEVSE > Finishing > Available > others
      if (connectors.some(c => c.status === 'CHARGING')) return 'CHARGING';
      if (connectors.some(c => c.status === 'PREPARING')) return 'PREPARING';
      if (connectors.some(c => c.status === 'SUSPENDED_EV')) return 'SUSPENDED_EV';
      if (connectors.some(c => c.status === 'SUSPENDED_EVSE')) return 'SUSPENDED_EVSE';
      if (connectors.some(c => c.status === 'FINISHING')) return 'FINISHING';
      if (connectors.every(c => c.status === 'AVAILABLE')) return 'AVAILABLE';
      
      // Default to first connector's status
      return connectors[0]?.status || 'UNAVAILABLE';
    };

    // Helper function to get most recent timestamp
    const getMostRecentTimestamp = (connectors: ChargingStationData[] | null): Date | null => {
      if (!connectors || connectors.length === 0) return null;
      
      return connectors.reduce((latest, connector) => {
        if (!connector.timestamp) return latest;
        return !latest || connector.timestamp > latest ? connector.timestamp : latest;
      }, null as Date | null);
    };

    this.sendSuccessResponse(res, {
      chargePointId: id,
      isConnected,
      status: getOverallStatus(data),
      lastSeen: getMostRecentTimestamp(data),
      connectorData: data, // This is now an array of all connectors
      connectorCount: data?.length || 0,
    });
  } catch (error) {
    this.logger.error('Error fetching charge point status:', error);
    this.sendErrorResponse(res, 500, 'Failed to fetch charge point status');
  }
}

  // Real-time data endpoints
  private async getAllRealtimeData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const allData = this.ocppServer.getAllChargePointsData();
      const dataObject = Object.fromEntries(allData);

      this.sendSuccessResponse(res, dataObject);
    } catch (error) {
      this.logger.error('Error fetching all real-time data:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch real-time data');
    }
  }

  private async getRealtimeData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { chargePointId } = req.params;
      const data = this.ocppServer.getChargePointData(chargePointId);

      if (!data) {
        return this.sendErrorResponse(res, 404, 'No real-time data available for this charge point');
      }

      return this.sendSuccessResponse(res, data);
    } catch (error) {
      this.logger.error('Error fetching real-time data:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch real-time data');
    }
  }

  public async sendMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        return this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        
      }

      const { id } = req.params;
      const { action, payload } = req.body;
      if (!action) {
        return this.sendErrorResponse(res, 400, 'Action is required');
      }
      const result = await this.ocppServer.sendMessage(id, action, payload || {});
      return this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error sending message to charge point:', error);
      return this.sendErrorResponse(res, 500, 'Failed to send message to charge point');
    }
  }

  // Control endpoints
  private async remoteStartTransaction(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        return this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        
      }

      const { chargePointId } = req.params;
      if (!chargePointId) {
         return this.sendErrorResponse(res, 404, "no chargepoint ID specified")
         
      }
      const { connectorId } = req.params;
      if(!connectorId) {
        return this.sendErrorResponse(res, 404, "no connector specified")
        
      }
      
      const operatorIdTag = req.user?.idTag?.idTag;
      if(!operatorIdTag){
        throw new Error("no idTag detected for operator")
      }
   const tagData = await this.db.getIdTag(operatorIdTag);
        if (!tagData || tagData.status !== "ACCEPTED") { // CORRECTED: Simplified status check
            throw new Error("Operator tag is not valid or accepted.");
        }
      

      // const { idTag, connectorId } = req.body;

      const result = await this.ocppServer.sendMessage(chargePointId, 'RemoteStartTransaction', {
        idTag:tagData.idTag,
        connectorId:parseInt(connectorId, 10),
      });

      this.sendSuccessResponse(res, result);
    } catch (error: any) {
      this.logger.error('Error starting remote transaction:', error);
      return this.sendErrorResponse(res, 500, error.message||'Failed to start remote transaction');
    }
  }

  private async remoteStopTransaction(req: AuthenticatedRequest, res: Response): Promise<void> {
     try {
      if (!this.ocppServer) {
        return this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        
      }

      const { chargePointId } = req.params;
      console.log('chargePointId', chargePointId);
      if (!chargePointId) {
         return this.sendErrorResponse(res, 404, "no chargepoint ID specified")
         
      }
      const { transactionId } = req.params;
      if(!transactionId) {
        return this.sendErrorResponse(res, 404, "no connector specified")
        
      }
      
  //     const operatorIdTag = req.user?.idTag?.idTag;
  //     if(!operatorIdTag){
  //       throw new Error("no idTag detected for operator")
  //     }
  //  const tagData = await this.db.getIdTag(operatorIdTag);
  //       if (!tagData || tagData.status !== "ACCEPTED") { // CORRECTED: Simplified status check
  //           throw new Error("Operator tag is not valid or accepted.");
  //       }
      

      // const { idTag, connectorId } = req.body;
      console.log('ChargePointId', chargePointId, 'TransactionId', transactionId);

      const result = await this.ocppServer.sendMessage(chargePointId, 'RemoteStopTransaction', {
        transactionId: parseInt(transactionId, 10),
      });

      this.sendSuccessResponse(res, result);
    } catch (error: any) {
      this.logger.error('Error starting remote transaction:', error);
      return this.sendErrorResponse(res, 500, error.message||'Failed to start remote transaction');
    }
  }

  private async resetChargePoint(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { chargePointId } = req.params;
      const { type = 'Soft' } = req.body;

      const result = await this.ocppServer.sendMessage(chargePointId, 'Reset', { type });
      return this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error resetting charge point:', error);
      return this.sendErrorResponse(res, 500, 'Failed to reset charge point');
    }
  }

  private async unlockConnector(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        return this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        
      }

      const { chargePointId } = req.params;
      const { connectorId } = req.body;

      const result = await this.ocppServer.sendMessage(chargePointId, 'UnlockConnector', { connectorId });
      return this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error unlocking connector:', error);
      return this.sendErrorResponse(res, 500, 'Failed to unlock connector');
    }
  }

  // Transaction endpoints
  private async getTransactions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {

      // Extract query parameters with defaults
      const {
        page = '1',
        limit = '10',
        search = '',
        sortBy = 'startTimestamp',
        order = 'desc'
      } = req.query as TransactionQueryParams;

      const pageNumber = Math.max(1, parseInt(page));
      const limitNumber = Math.max(1, Math.min(100, parseInt(limit))); // Max 100 items per page
      const skip = (pageNumber - 1) * limitNumber;

      const where: any = {};
      if (search) {
        where.OR = [
          { chargePointId: { contains: search, mode: 'insensitive' } },
          { idTag: { contains: search, mode: 'insensitive' } },
        ];

        const searchNumber = parseInt(search);
        if (!isNaN(searchNumber)) {
          where.OR.push({ transactionId: searchNumber });
        }
      }

      const orderBy = { [sortBy]: order };
      const [total, transactions] = await Promise.all([
        this.db.getTransactionsCount(where),
        this.db.getTransactions({ skip, take: limitNumber, where, orderBy })
      ]);

      if (!transactions || transactions.length === 0) {
        return this.sendErrorResponse(res, 404, 'No transactions found');
        
      }
      return this.sendSuccessResponse(res, {
        transactions,
        pagination: {
          total,
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(total / limitNumber)
        }
      });
    } catch (error) {
      this.logger.error('Error fetching transactions:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch transactions');
    }
  }

  private async getTransaction(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      let convertedId;
      if (!id) {
        return this.sendErrorResponse(res, 400, 'Transaction ID is required');
        
      }
      if(typeof(id) === "string"){
        convertedId = Number(id);
        if(isNaN(convertedId)){
          return this.sendErrorResponse(res, 400, 'Transaction ID must be a number');
        }
      }
      const transaction = await this.db.getTransaction((convertedId!));

      if (!transaction) {
        return this.sendErrorResponse(res, 404, 'Transaction not found');
      }

      return this.sendSuccessResponse(res, transaction);
    } catch (error) {
      this.logger.error('Error fetching transaction:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch transaction');
    }
  }

  private async getActiveTransactions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { chargePointId } = req.query;
      const transactions = await this.db.getActiveTransactions(chargePointId as string);

      return this.sendSuccessResponse(res, transactions);
    } catch (error) {
      this.logger.error('Error fetching active transactions:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch active transactions');
    }
  }

  // Configuration endpoints
  private async getConfiguration(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        return this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
      }

      const { id } = req.params;
      const { key } = req.query;

      const result = await this.ocppServer.sendMessage(id, 'GetConfiguration', {
        key: key ? [key] : undefined,
      });

      return this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error fetching configuration:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch configuration');
    }
  }

  private async changeConfiguration(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        return this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
      }

      const { id } = req.params;
      const { key, value } = req.body;

      const result = await this.ocppServer.sendMessage(id, 'ChangeConfiguration', {
        key,
        value,
      });

      // Also store in database
      await this.db.setChargePointConfiguration(id, key, value);

      return this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error changing configuration:', error);
      return this.sendErrorResponse(res, 500, 'Failed to change configuration');
    }
  }

  // Alarm endpoints
  private async getAlarms(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { chargePointId } = req.query;
      const alarms = await this.db.getActiveAlarms(chargePointId as string);

      return this.sendSuccessResponse(res, alarms);
    } catch (error) {
      this.logger.error('Error fetching alarms:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch alarms');
    }
  }

  private async resolveAlarm(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const resolvedBy = req.user?.username || 'system';

      const alarm = await this.db.resolveAlarm(id, resolvedBy);
      return this.sendSuccessResponse(res, alarm);
    } catch (error) {
      this.logger.error('Error resolving alarm:', error);
      return this.sendErrorResponse(res, 500, 'Failed to resolve alarm');
    }
  }

  // Analytics endpoints
  private async getStatistics(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { chargePointId, startDate, endDate } = req.query;

      const statistics = await this.db.getChargingStatistics(
        chargePointId as string,
        startDate ? new Date(startDate as string) : undefined,
        endDate ? new Date(endDate as string) : undefined
      );

      return this.sendSuccessResponse(res, statistics);
    } catch (error) {
      this.logger.error('Error fetching statistics:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch statistics');
    }
  }

  private async getEnergyConsumption(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { chargePointId, period = 'day' } = req.query;
 
      // Implementation for energy consumption analytics
      return this.sendSuccessResponse(res, { message: 'Energy consumption analytics endpoint' });
    } catch (error) {
      this.logger.error('Error fetching energy consumption:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch energy consumption');
    }
  }

  // User management endpoints
  private async getUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Implementation for getting users
      const users = await this.db.getAllUsers();
      if (!users || users.length === 0) {
        throw new Error('No users found');
      }

      return this.sendSuccessResponse(res, {
        message: 'Get users endpoint',
        users
      });
    } catch (error) {
      this.logger.error('Error fetching users:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch users');
    }
  }

  private async createUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Implementation for creating users
      const { username, email, role, isActive, phone, password } = req.body;
      if (!username || !email || isActive === undefined) {
        return this.sendErrorResponse(res, 400, 'Missing required fields');
        
      }
      const tag = generateHashedCode(email + Date.now().toString());
      console.log(tag);
      const data = { username, email, role, isActive, phone, password, idTag: tag };
      if (password) {
        data.password = await bcrypt.hash(password, 12);
      }
      // Create the user in the database
      const user = await this.db.createUser(data);
      if (!user) {
        throw new Error('Failed to create user');
      }
      return this.sendSuccessResponse(res, { message: 'Create user endpoint', user });
    } catch (error: Error | any) {
      this.logger.error('Error creating user:', error.message);
      const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return this.sendErrorResponse(res, statusCode, error.message || 'Failed to create user');

    }
  }

  private async deleteUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Implementation for deleting users
      this.sendSuccessResponse(res, { message: 'Delete user endpoint' });
    } catch (error) {
      this.logger.error('Error deleting user:', error);
      this.sendErrorResponse(res, 500, 'Failed to delete user');
    }
  }

  // Health check endpoint
  private async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const dbHealth = await this.db.healthCheck();
      const redisHealth = this.redis ? await this.redis.ping() : true;
      const connectedChargePoints = this.ocppServer?.getConnectedChargePoints().length ?? 0;

      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: dbHealth ? 'connected' : 'disconnected',
        redis: redisHealth ? 'connected' : 'disconnected',
        connectedChargePoints,
        version: process.env.npm_package_version || '1.0.0',
      };

      res.status(200).json(health);
    } catch (error) {
      this.logger.error('Health check failed:', error);
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Health check failed',
      });
    }
  }

  // Response helpers
  private sendSuccessResponse<T>(res: Response, data: T): void {
    const response: APIResponse<T> = {
      success: true,
      data,
      timestamp: new Date().toISOString(),
    };
    res.status(200).json(response);
  }

  // Error Handlers
  private sendErrorResponse(res: Response, statusCode: number, error: string): void {
    const response: APIResponse = {
      success: false,
      error,
      timestamp: new Date().toISOString(),
    };
    res.status(statusCode).json(response);
  }

  public getRouter(): Router {
    return this.router;
  }

  /**
   * Get all connectors for a specific charge point
   */
  private async getChargePointConnectors(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      if (!this.ocppServer) {
        return this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
      }

      const { id } = req.params;

      // Await the async discovery function
      const result = await this.ocppServer.getChargeStationGunDetails(id);

      if (!result) {
       return  this.sendErrorResponse(
          res,
          404,
          "Charge point not connected or no data available"
        );
        
      }

      const { connectors, metadata, success } = result;

      // Optional: build summary stats
      const summary = {
        total: connectors.length,
        available: connectors.filter((c) => c.status?.includes("Available")).length,
        charging: connectors.filter((c) => c.status?.includes("Charging")).length,
        faulted: connectors.filter((c) => c.status?.includes("Faulted")).length,
        unavailable: connectors.filter((c) => c.status?.includes("Unavailable")).length,
      };

      return this.sendSuccessResponse(res, {
        chargePointId: id,
        success,
        connectorCount: metadata.totalConnectors,
        metadata,
        summary,
        connectors,
        result
      });
    } catch (error) {
      this.logger.error("Error fetching charge point connectors:", error);
     return  this.sendErrorResponse(
        res,
        500,
        "Failed to fetch charge point connectors"
      );
    }
  }

  /**
   * Get specific connector data
   */
  private async getChargePointConnector(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        return this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        
      }

      const { id, connectorId } = req.params;
      const connector = this.ocppServer.triggerStatusForAll();

      if (!connector) {
        return this.sendErrorResponse(res, 404, 'Connector not found or charge point not connected');
        
      }

      this.sendSuccessResponse(res, connector);
    } catch (error) {
      this.logger.error('Error fetching connector:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch connector');
    }
  }
}