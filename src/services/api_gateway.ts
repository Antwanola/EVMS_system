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
import { APIResponse, APIUser } from '../types/ocpp_types';
import { TransactionQueryParams } from '../types/TnxQueryType';
import crypto from 'crypto';
import { UserStrutcture } from '@/types/apiHelperypes';


interface AuthenticatedRequest extends Request {
  user?: APIUser;
}

export class APIGateway {
  private router: Router;
  private logger = Logger.getInstance();
  private rateLimiter?: RateLimiterRedis;
  public clients: Array<Response> = [];

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


  private generateHashedCode(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 6).toUpperCase();
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
    this.router.post('/charge-points/:id/remote-start', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.remoteStartTransaction.bind(this));
    this.router.post('/charge-points/:id/remote-stop', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.remoteStopTransaction.bind(this));
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
    this.router.get('/users', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.getUsers.bind(this));
    this.router.post('/create-users', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.createUser.bind(this));
    this.router.post('/user/update', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.editUser.bind(this))
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

      const user = await this.db.createUser({
        username: value.username,
        email: value.email,
        password: hashedPassword,
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

  private async editUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    const schema = Joi.object({
      username: Joi.string().min(3).max(30),
      email: Joi.string().email(),
      password: Joi.string().min(6),
      role: Joi.string().valid('ADMIN', 'OPERATOR', 'VIEWER', 'THIRD_PARTY'),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      this.sendErrorResponse(res, 400, error.details[0].message);
      return;
    }
    const { email, role, password, username } = value;
    const data: UserStrutcture = {
      email,
      username,
      role,
      password,
    }

    try {
      const user = await this.db.getUserByEmail(value.email);

      if (!user) {
        this.sendErrorResponse(res, 404, 'User not found');
        return;
      }

      if(!user.idTag){
        Object.assign(data, { idTag: '' });
        data.idTag = this.generateHashedCode(user.email + Date.now().toString());
      }
      console.log("edit user", data);
      if (value.password) {
        const hashedPassword = await bcrypt.hash(value.password, 12);
        value.password = hashedPassword;
      }

      const updatedUser = await this.db.updateUser(value.email, data);

      this.sendSuccessResponse(res, {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        role: updatedUser.role,
      });
    } catch (error) {
      this.logger.error('Edit user error:', error);
      this.sendErrorResponse(res, 500, 'Failed to edit user');
    }
  }


  public async streamMeterValues(req: AuthenticatedRequest, res: Response): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    this.clients.push(res);

    req.on("close", () => {
      const index = this.clients.indexOf(res);
      if (index !== -1) this.clients.splice(index, 1);
    });

    // Keep connection alive - don't call next() or return
  }

  public sendMeterValueToClients = (data: any): void => {
    for (const client of this.clients) {
      try {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        this.logger.error('Error sending meter value to client:', error);
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
      const data = this.ocppServer.getChargePointData(id);

      this.sendSuccessResponse(res, {
        chargePointId: id,
        isConnected,
        status: data?.status || 'UNAVAILABLE',
        lastSeen: data?.timestamp || null,
        connectorData: data,
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
        this.sendErrorResponse(res, 404, 'No real-time data available for this charge point');
        return;
      }

      this.sendSuccessResponse(res, data);
    } catch (error) {
      this.logger.error('Error fetching real-time data:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch real-time data');
    }
  }

  public async sendMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const { action, payload } = req.body;
      if (!action) {
        this.sendErrorResponse(res, 400, 'Action is required');
        return;
      }
      const result = await this.ocppServer.sendMessage(id, action, payload || {});
      this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error sending message to charge point:', error);
      this.sendErrorResponse(res, 500, 'Failed to send message to charge point');
    }
  }

  // Control endpoints
  private async remoteStartTransaction(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const { idTag, connectorId } = req.body;

      const result = await this.ocppServer.sendMessage(id, 'RemoteStartTransaction', {
        idTag,
        connectorId,
      });

      this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error starting remote transaction:', error);
      this.sendErrorResponse(res, 500, 'Failed to start remote transaction');
    }
  }

  private async remoteStopTransaction(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const { transactionId } = req.body;

      const result = await this.ocppServer.sendMessage(id, 'RemoteStopTransaction', {
        transactionId,
      });

      this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error stopping remote transaction:', error);
      this.sendErrorResponse(res, 500, 'Failed to stop remote transaction');
    }
  }

  private async resetChargePoint(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const { type = 'Soft' } = req.body;

      const result = await this.ocppServer.sendMessage(id, 'Reset', { type });
      this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error resetting charge point:', error);
      this.sendErrorResponse(res, 500, 'Failed to reset charge point');
    }
  }

  private async unlockConnector(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const { connectorId } = req.body;

      const result = await this.ocppServer.sendMessage(id, 'UnlockConnector', { connectorId });
      this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error unlocking connector:', error);
      this.sendErrorResponse(res, 500, 'Failed to unlock connector');
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
        this.sendErrorResponse(res, 404, 'No transactions found');
        return;
      }
      this.sendSuccessResponse(res, {
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
      this.sendErrorResponse(res, 500, 'Failed to fetch transactions');
    }
  }

  private async getTransaction(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const transaction = await this.db.getTransaction(parseInt(id));

      if (!transaction) {
        this.sendErrorResponse(res, 404, 'Transaction not found');
        return;
      }

      this.sendSuccessResponse(res, transaction);
    } catch (error) {
      this.logger.error('Error fetching transaction:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch transaction');
    }
  }

  private async getActiveTransactions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { chargePointId } = req.query;
      const transactions = await this.db.getActiveTransactions(chargePointId as string);

      this.sendSuccessResponse(res, transactions);
    } catch (error) {
      this.logger.error('Error fetching active transactions:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch active transactions');
    }
  }

  // Configuration endpoints
  private async getConfiguration(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const { key } = req.query;

      const result = await this.ocppServer.sendMessage(id, 'GetConfiguration', {
        key: key ? [key] : undefined,
      });

      this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error fetching configuration:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch configuration');
    }
  }

  private async changeConfiguration(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!this.ocppServer) {
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;
      const { key, value } = req.body;

      const result = await this.ocppServer.sendMessage(id, 'ChangeConfiguration', {
        key,
        value,
      });

      // Also store in database
      await this.db.setChargePointConfiguration(id, key, value);

      this.sendSuccessResponse(res, result);
    } catch (error) {
      this.logger.error('Error changing configuration:', error);
      this.sendErrorResponse(res, 500, 'Failed to change configuration');
    }
  }

  // Alarm endpoints
  private async getAlarms(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { chargePointId } = req.query;
      const alarms = await this.db.getActiveAlarms(chargePointId as string);

      this.sendSuccessResponse(res, alarms);
    } catch (error) {
      this.logger.error('Error fetching alarms:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch alarms');
    }
  }

  private async resolveAlarm(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const resolvedBy = req.user?.username || 'system';

      const alarm = await this.db.resolveAlarm(id, resolvedBy);
      this.sendSuccessResponse(res, alarm);
    } catch (error) {
      this.logger.error('Error resolving alarm:', error);
      this.sendErrorResponse(res, 500, 'Failed to resolve alarm');
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

      this.sendSuccessResponse(res, statistics);
    } catch (error) {
      this.logger.error('Error fetching statistics:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch statistics');
    }
  }

  private async getEnergyConsumption(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { chargePointId, period = 'day' } = req.query;

      // Implementation for energy consumption analytics
      this.sendSuccessResponse(res, { message: 'Energy consumption analytics endpoint' });
    } catch (error) {
      this.logger.error('Error fetching energy consumption:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch energy consumption');
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

      this.sendSuccessResponse(res, {
        message: 'Get users endpoint',
        users
      });
    } catch (error) {
      this.logger.error('Error fetching users:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch users');
    }
  }

  private async createUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Implementation for creating users
      const { username, email, role, isActive, phone, password } = req.body;
      if (!username || !email || isActive === undefined) {
        this.sendErrorResponse(res, 400, 'Missing required fields');
        return;
      }
      const tag = this.generateHashedCode(email + Date.now().toString());
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
      this.sendSuccessResponse(res, { message: 'Create user endpoint', user });
    } catch (error: Error | any) {
      this.logger.error('Error creating user:', error.message);
      const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
      this.sendErrorResponse(res, statusCode, error.message || 'Failed to create user');

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
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id } = req.params;

      // Await the async discovery function
      const result = await this.ocppServer.getChargeStationGunDetails(id);

      if (!result) {
        this.sendErrorResponse(
          res,
          404,
          "Charge point not connected or no data available"
        );
        return;
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

      this.sendSuccessResponse(res, {
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
      this.sendErrorResponse(
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
        this.sendErrorResponse(res, 503, 'OCPP Server not initialized');
        return;
      }

      const { id, connectorId } = req.params;
      const connector = this.ocppServer.triggerStatusForAll();

      if (!connector) {
        this.sendErrorResponse(res, 404, 'Connector not found or charge point not connected');
        return;
      }

      this.sendSuccessResponse(res, connector);
    } catch (error) {
      this.logger.error('Error fetching connector:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch connector');
    }
  }
}