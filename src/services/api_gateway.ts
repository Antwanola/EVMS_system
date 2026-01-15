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
import { generateHashedCode } from '../helpers/helper';
import { stringify } from 'querystring';
import { ClientFilter } from '@/types/stream_types';
import { IdTagStatus } from '@/types/userWithRelations'


interface AuthenticatedRequest extends Request {
  user?: APIUser;
}

interface PendingChargeSession {
  transactionType?: string
  vehicleId: string
  fleetId?: string
  attendantIdTag: string
  timestamp: number 
}
export const pendingChargeSessions = new Map<string, PendingChargeSession>(); // Key: `${chargePointId}:${connectorId}`

export class APIGateway {
  private router: Router;
  private logger = Logger.getInstance();
  private rateLimiter?: RateLimiterRedis;
  //  public clients: Map<Response, { chargePointId?: string, connectorId?: number }> = new Map();
  public clients: Map<Response, ClientFilter> = new Map()

  // Fleet validation constants
  private readonly VALID_FLEET_TYPES = [
    'COMMERCIAL', 'GOVERNMENT', 'LOGISTICS', 'TAXI_RIDESHARE',
    'RENTAL', 'PERSONAL', 'UTILITY', 'EMERGENCY', 'PUBLIC_TRANSPORT', 'OTHER'
  ];

  private readonly VALID_AFRICAN_COUNTRIES = [
    'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cameroon',
    'Central African Republic', 'Chad', 'Comoros', 'Congo', 'Democratic Republic of the Congo', 'Djibouti',
    'Egypt', 'Equatorial Guinea', 'Eritrea', 'Eswatini', 'Ethiopia', 'Gabon', 'Gambia', 'Ghana',
    'Guinea', 'Guinea-Bissau', 'Ivory Coast', 'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar',
    'Malawi', 'Mali', 'Mauritania', 'Mauritius', 'Morocco', 'Mozambique', 'Namibia', 'Niger',
    'Nigeria', 'Rwanda', 'Sao Tome and Principe', 'Senegal', 'Seychelles', 'Sierra Leone', 'Somalia',
    'South Africa', 'South Sudan', 'Sudan', 'Tanzania', 'Togo', 'Tunisia', 'Uganda', 'Zambia', 'Zimbabwe'
  ];

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
    this.router.get('/transactions/latest/', this.authenticateUser.bind(this), this.getLatest5TXN.bind(this));
    this.router.get('/transactions/:id', this.authenticateUser.bind(this), this.getTransaction.bind(this));
    this.router.get('/transactions/active', this.authenticateUser.bind(this), this.getActiveTransactions.bind(this));

    // Control routes (requires higher permissions)
    this.router.post('/charge-points/remote-start/:chargePointId/:connectorId', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.remoteStartTransaction.bind(this));
    this.router.post('/charge-points/remote-stop/:chargePointId/:transactionId', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.remoteStopTransaction.bind(this));
    this.router.post('/charge-points/:id/reset', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.resetChargePoint.bind(this));
    this.router.post('/charge-points/:id/unlock', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.unlockConnector.bind(this));
    this.router.post('/update-charge-point/:chargePointId', this.authenticateUser.bind(this), this.updateChargeStation.bind(this));

    // Configuration routes
    this.router.get('/charge-points/:id/configuration', this.authenticateUser.bind(this), this.getConfiguration.bind(this));
    this.router.post('/charge-points/:id/configuration', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.changeConfiguration.bind(this));
    this.router.get('/stream-metervalues/:chargePointId/:connectorId', this.streamMeterValues.bind(this));
    this.router.get('/get-user-by-idtag/:idTag', this.authenticateUser.bind(this), this.getUserByIdTag.bind(this));

    // Alarm routes
    this.router.get('/alarms', this.authenticateUser.bind(this), this.getAlarms.bind(this));
    this.router.post('/alarms/:id/resolve', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.resolveAlarm.bind(this));

    // Analytics routes
    this.router.get('/analytics/statistics', this.authenticateUser.bind(this), this.getStatistics.bind(this));
    this.router.get('/analytics/energy-consumption', this.authenticateUser.bind(this), this.getEnergyConsumption.bind(this));

    // User management routes (Admin only)
    this.router.get('/users/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getOneUser.bind(this));
    this.router.get('/users', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.getUsers.bind(this));
    this.router.post('/create-users', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.createUser.bind(this));
    this.router.post('/users/update', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.editUser.bind(this))
    this.router.delete('/users/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.deleteUser.bind(this));

    //Fleet management route(operator specifics)
    this.router.get('/fleet', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getAllFleets.bind(this))
    this.router.get('/fleet/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getFleetById.bind(this))
    this.router.post('/create-fleet', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.createFleet.bind(this))
    this.router.put('/edit-fleet/:fleetId', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.updateFleetById.bind(this))
    this.router.delete('/fleet/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.deleteFleet.bind(this))

    // Fleet vehicle management
    this.router.post('/fleet/:fleetId/vehicles', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.addVehicleToFleet.bind(this))
    this.router.delete('/fleet/:fleetId/vehicles/:vehicleId', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.removeVehicleFromFleet.bind(this))
    this.router.get('/fleet/:fleetId/vehicles', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getFleetVehicles.bind(this))

    // Fleet manager management
    this.router.post('/fleet/:fleetId/managers', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.addFleetManager.bind(this))
    this.router.delete('/fleet/:fleetId/managers/:userId', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.removeFleetManager.bind(this))

    // Fleet reporting
    this.router.get('/fleet/:fleetId/transactions', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getFleetTransactions.bind(this))
    this.router.get('/fleet/:fleetId/reports/energy', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getFleetEnergyReport.bind(this))
    this.router.get('/fleet/:fleetId/reports/utilization', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getFleetUtilizationReport.bind(this))

    // Vehicle management routes
    this.router.get('/vehicles', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getAllVehicles.bind(this))
    this.router.get('/vehicles/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getVehicleById.bind(this))
    this.router.get('/vehicles/:id/transactions', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.getVehicleTransactions.bind(this))
    this.router.post('/create-vehicles', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.createVehicle.bind(this))
    this.router.put('/vehicles/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.updateVehicle.bind(this))
    this.router.delete('/vehicles/:id', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.deleteVehicle.bind(this))


    // System Settings routes
    this.router.get('/settings', this.authenticateUser.bind(this), this.getSettings.bind(this));
    this.router.get('/settings/public', this.getPublicSettings.bind(this)); // No auth required for public settings
    this.router.get('/settings/category/:category', this.authenticateUser.bind(this), this.getSettingsByCategory.bind(this));
    this.router.get('/settings/:key', this.authenticateUser.bind(this), this.getSetting.bind(this));
    this.router.post('/create-settings', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.createSetting.bind(this));
    this.router.put('/settings/:key', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.updateSetting.bind(this));
    this.router.delete('/settings/:key', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.deleteSetting.bind(this));
    this.router.get('/settings/:key/history', this.authenticateUser.bind(this), this.requireRole(['ADMIN']), this.getSettingHistory.bind(this));

    // Quick settings endpoints for common operations
    this.router.get('/settings/pricing/current', this.authenticateUser.bind(this), this.getCurrentPricing.bind(this));
    this.router.put('/settings/pricing/price-per-kwh', this.authenticateUser.bind(this), this.requireRole(['ADMIN', 'OPERATOR']), this.updatePricePerKWh.bind(this));

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
        status: 'ACCEPTED' as const,
        expiryDate: undefined
      }
      const createTag = await this.db.createIdTag(data)
      if (!createTag) {
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
      if (!id) return

      const user = await this.db.getUserById(id);
      if (!user) {
        this.sendErrorResponse(res, 404, 'User not found');
      }
      this.sendSuccessResponse(res, { message: 'User fetched successfully', user });
    } catch (error) {
      this.logger.error('Error fetching user:', error);
      this.sendErrorResponse(res, 500, 'Failed to fetch user');
    }
  }

  private async getUserByIdTag(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { idTag } = req.params;
    if (!idTag) {
      this.sendErrorResponse(res, 400, 'no idTag value found in input');
      return;
    }

    try {
      const idTagData = await this.db.getUserByIdTag(idTag);
      if (!idTagData || !idTagData.user) {
        return this.sendErrorResponse(res, 404, "user not found");
      }

      // Return the user data (excluding sensitive fields like password)
      const { password, ...userWithoutPassword } = idTagData.user;
      this.sendSuccessResponse(res, {
        message: 'User fetched successfully',
        user: userWithoutPassword,
        idTag: {
          idTag: idTagData.idTag,
          status: idTagData.status,
          expiryDate: idTagData.expiryDate
        }
      });
      console.log({ user: userWithoutPassword });
    } catch (error: any) {
      return this.sendErrorResponse(res, 500, error.message);
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


  public async streamMeterValues(req: AuthenticatedRequest, res: Response): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const { chargePointId, connectorId } = req.params;
    const normalizedConnectorId = connectorId ? parseInt(connectorId, 10) : undefined;

    // this.clients.push(res);
    this.clients.set(res, { chargePointId, connectorId: normalizedConnectorId })
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      filters: { chargePointId, connectorId }
    })}\n\n`);

    req.on("close", () => {
      this.clients.delete(res)
    });
  }

  public sendMeterValueToClients = (data: any): void => {
    const meterChargePointId = data.chargePointId;
    const meterConnectorId = data.connectorId;
    for (const [client, filter] of this.clients.entries()) {
      try {
        //chargePoint Filter
        if (filter.chargePointId && filter.chargePointId !== meterChargePointId) {
          continue;
        }

        //connector filter
        if (filter.connectorId !== undefined && filter.connectorId !== meterConnectorId) {
          continue;
        }

        client.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        this.logger.error('Error sending meter value to client:', error);
        this.clients.delete(client)
      }
    }
  }

  //Create Fleet
  private async createFleet(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        name,
        organizationName,
        registrationNumber,
        taxId,
        contactEmail,
        contactPhone,
        website,
        address,
        city,
        state,
        country,
        postalCode,
        fleetType,
        billingEmail,
        accountManager,
        creditLimit,
        paymentTerms,
        logoImage
      } = req.body;

      // Validation
      if (!name || !contactEmail) {
        return this.sendErrorResponse(res, 400, 'Fleet name and contact email are required');
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(contactEmail)) {
        return this.sendErrorResponse(res, 400, 'Invalid contact email format');
      }

      if (billingEmail && !emailRegex.test(billingEmail)) {
        return this.sendErrorResponse(res, 400, 'Invalid billing email format');
      }

      // Validate fleet type if provided
      const validFleetTypes = [
        'COMMERCIAL', 'GOVERNMENT', 'LOGISTICS', 'TAXI_RIDESHARE',
        'RENTAL', 'PERSONAL', 'UTILITY', 'EMERGENCY', 'PUBLIC_TRANSPORT', 'OTHER'
      ];
      if (fleetType && !validFleetTypes.includes(fleetType)) {
        return this.sendErrorResponse(res, 400, `Invalid fleet type. Must be one of: ${validFleetTypes.join(', ')}`);
      }

      // Validate country if provided (restrict to African countries)
      const validAfricanCountries = [
        'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cameroon',
        'Central African Republic', 'Chad', 'Comoros', 'Congo', 'Democratic Republic of the Congo', 'Djibouti',
        'Egypt', 'Equatorial Guinea', 'Eritrea', 'Eswatini', 'Ethiopia', 'Gabon', 'Gambia', 'Ghana',
        'Guinea', 'Guinea-Bissau', 'Ivory Coast', 'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar',
        'Malawi', 'Mali', 'Mauritania', 'Mauritius', 'Morocco', 'Mozambique', 'Namibia', 'Niger',
        'Nigeria', 'Rwanda', 'Sao Tome and Principe', 'Senegal', 'Seychelles', 'Sierra Leone', 'Somalia',
        'South Africa', 'South Sudan', 'Sudan', 'Tanzania', 'Togo', 'Tunisia', 'Uganda', 'Zambia', 'Zimbabwe'
      ];
      if (country && !validAfricanCountries.includes(country)) {
        return this.sendErrorResponse(res, 400, `Invalid country. Must be an African country. Valid options: ${validAfricanCountries.join(', ')}`);
      }
      // Create fleet in database
      const fleet = await this.db.createFleet({
        name,
        organizationName,
        registrationNumber,
        taxId,
        contactEmail,
        contactPhone,
        website,
        address,
        city,
        state,
        country,
        postalCode,
        fleetType: fleetType || 'COMMERCIAL',
        billingEmail,
        accountManager,
        creditLimit,
        paymentTerms,
        logoImage,
      });

      // Optionally assign the creating user as a fleet manager
      if (req.user?.id) {
        try {
          // Map user role to fleet manager role
          let fleetManagerRole: 'ADMIN' | 'MANAGER' | 'VIEWER' | 'BILLING' = 'VIEWER';
          let canManageVehicles = false;
          let canManageBilling = false;

          switch (req.user.role) {
            case 'ADMIN':
              fleetManagerRole = 'ADMIN';
              canManageVehicles = true;
              canManageBilling = true;
              break;
            case 'OPERATOR':
              fleetManagerRole = 'MANAGER';
              canManageVehicles = true;
              canManageBilling = false;
              break;
            case 'VIEWER':
              fleetManagerRole = 'VIEWER';
              canManageVehicles = false;
              canManageBilling = false;
              break;
            case 'THIRD_PARTY':
              fleetManagerRole = 'VIEWER';
              canManageVehicles = false;
              canManageBilling = false;
              break;
            default:
              fleetManagerRole = 'VIEWER';
              canManageVehicles = false;
              canManageBilling = false;
          }

          await this.db.addFleetManager({
            fleetId: fleet.id,
            userId: req.user.id,
            role: fleetManagerRole,
            canManageVehicles,
            canViewReports: true,
            canManageBilling,
            assignedBy: req.user.id,
          });
        } catch (managerError) {
          this.logger.warn('Failed to assign fleet manager:', managerError);
          // Don't fail the fleet creation if manager assignment fails
        }
      }

      return this.sendSuccessResponse(res, {
        message: 'Fleet created successfully',
        fleet: {
          id: fleet.id,
          name: fleet.name,
          organizationName: fleet.organizationName,
          contactEmail: fleet.contactEmail,
          fleetType: fleet.fleetType,
          createdAt: fleet.createdAt,
        }
      });

    } catch (error: any) {
      this.logger.error('Error creating fleet:', error);

      // Handle specific database errors
      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('registrationNumber')) {
          return this.sendErrorResponse(res, 409, 'Registration number already exists');
        }
        if (error.meta?.target?.includes('taxId')) {
          return this.sendErrorResponse(res, 409, 'Tax ID already exists');
        }
      }

      return this.sendErrorResponse(res, 500, 'Failed to create fleet');
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
      if (!connectorId) {
        return this.sendErrorResponse(res, 404, "no connector specified")

      }

      const {
        transactionType,
        vehicleId,
        fleetId,
        idTag
      } = req.body;

      const Key = `${chargePointId}:${connectorId}`
      pendingChargeSessions.set(Key, {transactionType, vehicleId, fleetId, attendantIdTag:idTag, timestamp: Date.now()})


      console.log("the tf data", req.body)



      const operatorIdTag = req.user?.idTag?.idTag;
      if (!operatorIdTag) {
        throw new Error("no idTag detected for operator")
      }

      // Use getUserByIdTag instead of getUserById since operatorIdTag is the actual idTag string
      const idTagData = await this.db.getUserByIdTag(operatorIdTag);
      if (!idTagData || idTagData.status !== "ACCEPTED") {
        throw new Error("Operator tag is not valid or accepted.");
      }

      // const { idTag, connectorId } = req.body;

      const result = await this.ocppServer.sendMessage(chargePointId, 'RemoteStartTransaction', {
        idTag: operatorIdTag, // Use the actual idTag string
        connectorId: parseInt(connectorId, 10),
      });

      this.sendSuccessResponse(res, result);
    } catch (error: any) {
      this.logger.error('Error starting remote transaction:', error);
      return this.sendErrorResponse(res, 500, error.message || 'Failed to start remote transaction');
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
      if (!transactionId) {
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
      return this.sendErrorResponse(res, 500, error.message || 'Failed to start remote transaction');
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
          {
            idTag: {
              idTag: { contains: search, mode: 'insensitive' }
            }
          }, // Search by the actual idTag string
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

  private async getLatest5TXN(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Extract query parameters with defaults
      const {
        page = '1',
        limit = '5',
        search = '',
        sortBy = 'stopTimestamp',
        order = 'desc'
      } = req.query as TransactionQueryParams;

      const pageNumber = Math.max(1, parseInt(page));
      const limitNumber = Math.max(1, Math.min(100, parseInt(limit))); // Max 100 items per page
      const skip = (pageNumber - 1) * limitNumber;

      const where: any = {};
      // Only show completed transactions (those with both meterStart and meterStop)
      where.meterStop = { not: null };
      where.stopTimestamp = { not: null };

      if (search) {
        where.OR = [
          { chargePointId: { contains: search, mode: 'insensitive' } },
          {
            idTag: {
              idTag: { contains: search, mode: 'insensitive' }
            }
          }, // Search by the actual idTag string
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

      // Enrich transactions with usernames
      const enrichedTxn = transactions.map((transaction: any) => {
        let username = null;
        // Use the idTag relation that's already included in the transaction
        if (transaction.idTag?.user?.username) {
          username = transaction.idTag.user.username;
        }

        return {
          ...transaction,
          username // Add username to transaction object
        };
      });

      return this.sendSuccessResponse(res, {
        transactions: enrichedTxn, // Fixed: return enriched transactions
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
      if (typeof (id) === "string") {
        convertedId = Number(id);
        if (isNaN(convertedId)) {
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

  // Fleet Management endpoints
  private async getAllFleets(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const fleets = await this.db.getAllFleets();

      return this.sendSuccessResponse(res, {
        fleets,
        total: fleets.length
      });
    } catch (error) {
      this.logger.error('Error fetching fleets:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch fleets');
    }
  }

  private async getFleetById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        return this.sendErrorResponse(res, 400, 'Fleet ID is required');
      }

      const fleet = await this.db.getFleetById(id);

      if (!fleet) {
        return this.sendErrorResponse(res, 404, 'Fleet not found');
      }

      return this.sendSuccessResponse(res, { fleet });
    } catch (error) {
      this.logger.error('Error fetching fleet:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch fleet');
    }
  }

  private async updateFleetById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId } = req.params;
      const {
        // Remove fields that might not be in the current Prisma client
        fleetLogo,
        logoImage,
        ...requestData
      } = req.body;

      if (!fleetId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID is required');
      }

      // Validate email formats if provided
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (requestData.contactEmail && !emailRegex.test(requestData.contactEmail)) {
        return this.sendErrorResponse(res, 400, 'Invalid contact email format');
      }
      if (requestData.billingEmail && !emailRegex.test(requestData.billingEmail)) {
        return this.sendErrorResponse(res, 400, 'Invalid billing email format');
      }

      // Validate fleet type if provided
      const validFleetTypes = [
        'COMMERCIAL', 'GOVERNMENT', 'LOGISTICS', 'TAXI_RIDESHARE',
        'RENTAL', 'PERSONAL', 'UTILITY', 'EMERGENCY', 'PUBLIC_TRANSPORT', 'OTHER'
      ];
      if (requestData.fleetType && !validFleetTypes.includes(requestData.fleetType)) {
        return this.sendErrorResponse(res, 400, `Invalid fleet type. Must be one of: ${validFleetTypes.join(', ')}`);
      }

      // Validate country if provided (restrict to African countries)
      const validAfricanCountries = [
        'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cameroon',
        'Central African Republic', 'Chad', 'Comoros', 'Congo', 'Democratic Republic of the Congo', 'Djibouti',
        'Egypt', 'Equatorial Guinea', 'Eritrea', 'Eswatini', 'Ethiopia', 'Gabon', 'Gambia', 'Ghana',
        'Guinea', 'Guinea-Bissau', 'Ivory Coast', 'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar',
        'Malawi', 'Mali', 'Mauritania', 'Mauritius', 'Morocco', 'Mozambique', 'Namibia', 'Niger',
        'Nigeria', 'Rwanda', 'Sao Tome and Principe', 'Senegal', 'Seychelles', 'Sierra Leone', 'Somalia',
        'South Africa', 'South Sudan', 'Sudan', 'Tanzania', 'Togo', 'Tunisia', 'Uganda', 'Zambia', 'Zimbabwe'
      ];
      if (requestData.country && !validAfricanCountries.includes(requestData.country)) {
        return this.sendErrorResponse(res, 400, `Invalid country. Must be an African country. Valid options: ${validAfricanCountries.join(', ')}`);
      }

      // Build clean update data object, excluding fields that might cause issues
      const updateData: any = {};

      // Only include fields that are definitely in the schema
      const allowedFields = [
        'name', 'organizationName', 'registrationNumber', 'taxId',
        'contactEmail', 'contactPhone', 'website',
        'address', 'city', 'state', 'country', 'postalCode',
        'fleetSize', 'fleetType',
        'billingEmail', 'accountManager', 'creditLimit', 'paymentTerms',
        'isActive', 'status'
      ];

      // Only add fields that are in the allowed list and provided in the request
      for (const field of allowedFields) {
        if (requestData[field] !== undefined) {
          updateData[field] = requestData[field];
        }
      }

      // Handle logo fields separately (use fleetLogo instead of logoImage for now)
      if (fleetLogo !== undefined) {
        updateData.fleetLogo = fleetLogo;
      } else if (logoImage !== undefined) {
        updateData.fleetLogo = logoImage; // Map logoImage to fleetLogo
      }

      const updatedFleet = await this.db.updateFleet(fleetId, updateData);

      return this.sendSuccessResponse(res, {
        message: 'Fleet updated successfully',
        fleet: updatedFleet
      });
    } catch (error: any) {
      this.logger.error('Error updating fleet:', error);

      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('registrationNumber')) {
          return this.sendErrorResponse(res, 409, 'Registration number already exists');
        }
        if (error.meta?.target?.includes('taxId')) {
          return this.sendErrorResponse(res, 409, 'Tax ID already exists');
        }
      }

      return this.sendErrorResponse(res, 500, `Failed to update fleet: ${error.message}`);
    }
  }

  private async deleteFleet(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      if (!id) {
        return this.sendErrorResponse(res, 400, 'Fleet ID is required');
      }

      const deletedFleet = await this.db.softDeleteFleet(
        id,
        req.user!.id,
        reason || 'Fleet deleted by admin'
      );

      return this.sendSuccessResponse(res, {
        message: 'Fleet deleted successfully',
        fleet: {
          id: deletedFleet.id,
          name: deletedFleet.name,
          status: deletedFleet.status,
          deletedAt: deletedFleet.deletedAt
        }
      });
    } catch (error) {
      this.logger.error('Error deleting fleet:', error);
      return this.sendErrorResponse(res, 500, 'Failed to delete fleet');
    }
  }

  // Fleet Vehicle Management
  private async addVehicleToFleet(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId } = req.params;
      const { vehicleId } = req.body;

      if (!fleetId || !vehicleId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID and Vehicle ID are required');
      }

      const updatedVehicle = await this.db.assignVehicleToFleet(
        vehicleId,
        fleetId,
        req.user!.id
      );

      return this.sendSuccessResponse(res, {
        message: 'Vehicle added to fleet successfully',
        vehicle: updatedVehicle
      });
    } catch (error: any) {
      this.logger.error('Error adding vehicle to fleet:', error);

      if (error.message?.includes('not found')) {
        return this.sendErrorResponse(res, 404, 'Vehicle not found');
      }

      return this.sendErrorResponse(res, 500, 'Failed to add vehicle to fleet');
    }
  }

  private async removeVehicleFromFleet(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId, vehicleId } = req.params;
      const { newOwnerId } = req.body;

      if (!fleetId || !vehicleId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID and Vehicle ID are required');
      }

      const updatedVehicle = await this.db.removeVehicleFromFleet(
        vehicleId,
        newOwnerId,
        req.user!.id
      );

      return this.sendSuccessResponse(res, {
        message: 'Vehicle removed from fleet successfully',
        vehicle: updatedVehicle
      });
    } catch (error) {
      this.logger.error('Error removing vehicle from fleet:', error);
      return this.sendErrorResponse(res, 500, 'Failed to remove vehicle from fleet');
    }
  }

  private async getFleetVehicles(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId } = req.params;

      if (!fleetId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID is required');
      }

      const fleet = await this.db.getFleetById(fleetId);

      if (!fleet) {
        return this.sendErrorResponse(res, 404, 'Fleet not found');
      }

      // Cast fleet to any to access vehicles property (temporary until Prisma types are available)
      const fleetWithVehicles = fleet as any;

      return this.sendSuccessResponse(res, {
        fleetId,
        fleetName: fleet.name,
        vehicles: fleetWithVehicles.vehicles || [],
        total: fleetWithVehicles.vehicles?.length || 0
      });
    } catch (error) {
      this.logger.error('Error fetching fleet vehicles:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch fleet vehicles');
    }
  }

  // Fleet Manager Management
  private async addFleetManager(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId } = req.params;
      const {
        userId,
        role = 'VIEWER',
        canManageVehicles = false,
        canViewReports = true,
        canManageBilling = false
      } = req.body;

      if (!fleetId || !userId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID and User ID are required');
      }

      const fleetManager = await this.db.addFleetManager({
        fleetId,
        userId,
        role,
        canManageVehicles,
        canViewReports,
        canManageBilling,
        assignedBy: req.user!.id
      });

      return this.sendSuccessResponse(res, {
        message: 'Fleet manager added successfully',
        fleetManager
      });
    } catch (error: any) {
      this.logger.error('Error adding fleet manager:', error);

      if (error.code === 'P2002') {
        return this.sendErrorResponse(res, 409, 'User is already a manager of this fleet');
      }

      return this.sendErrorResponse(res, 500, 'Failed to add fleet manager');
    }
  }

  private async removeFleetManager(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId, userId } = req.params;

      if (!fleetId || !userId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID and User ID are required');
      }

      await this.db.removeFleetManager(fleetId, userId);

      return this.sendSuccessResponse(res, {
        message: 'Fleet manager removed successfully'
      });
    } catch (error) {
      this.logger.error('Error removing fleet manager:', error);
      return this.sendErrorResponse(res, 500, 'Failed to remove fleet manager');
    }
  }

  // Fleet Reporting
  private async getFleetTransactions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId } = req.params;
      const { startDate, endDate, limit = '100' } = req.query;

      if (!fleetId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID is required');
      }

      const transactions = await this.db.getFleetTransactions(
        fleetId,
        startDate ? new Date(startDate as string) : undefined,
        endDate ? new Date(endDate as string) : undefined,
        parseInt(limit as string)
      );

      return this.sendSuccessResponse(res, {
        fleetId,
        transactions,
        total: transactions.length
      });
    } catch (error) {
      this.logger.error('Error fetching fleet transactions:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch fleet transactions');
    }
  }

  private async getFleetEnergyReport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId } = req.params;
      const { startDate, endDate } = req.query;

      if (!fleetId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID is required');
      }

      const energyReport = await this.db.getFleetEnergyConsumption(
        fleetId,
        startDate ? new Date(startDate as string) : undefined,
        endDate ? new Date(endDate as string) : undefined
      );

      return this.sendSuccessResponse(res, {
        fleetId,
        period: {
          startDate: startDate || null,
          endDate: endDate || null
        },
        ...energyReport
      });
    } catch (error) {
      this.logger.error('Error fetching fleet energy report:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch fleet energy report');
    }
  }

  private async getFleetUtilizationReport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { fleetId } = req.params;

      if (!fleetId) {
        return this.sendErrorResponse(res, 400, 'Fleet ID is required');
      }

      const utilizationReport = await this.db.getFleetVehicleUtilization(fleetId);

      return this.sendSuccessResponse(res, {
        fleetId,
        vehicles: utilizationReport,
        total: utilizationReport.length
      });
    } catch (error) {
      this.logger.error('Error fetching fleet utilization report:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch fleet utilization report');
    }
  }

  // Vehicle Management endpoints
  private async getAllVehicles(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { page = '1', limit = '20', search, fleetId, ownerId } = req.query;

      const pageNumber = Math.max(1, parseInt(page as string));
      const limitNumber = Math.max(1, Math.min(100, parseInt(limit as string)));

      const vehicles = await this.db.getAllVehicles();

      // Apply filters if provided
      let filteredVehicles = vehicles;

      if (search) {
        const searchTerm = (search as string).toLowerCase();
        filteredVehicles = vehicles.filter((vehicle: any) =>
          vehicle.make?.toLowerCase().includes(searchTerm) ||
          vehicle.model?.toLowerCase().includes(searchTerm) ||
          vehicle.licensePlate?.toLowerCase().includes(searchTerm) ||
          vehicle.vin?.toLowerCase().includes(searchTerm)
        );
      }

      if (fleetId) {
        filteredVehicles = filteredVehicles.filter((vehicle: any) => vehicle.fleetId === fleetId);
      }

      if (ownerId) {
        filteredVehicles = filteredVehicles.filter((vehicle: any) => vehicle.ownerId === ownerId);
      }

      // Pagination
      const startIndex = (pageNumber - 1) * limitNumber;
      const paginatedVehicles = filteredVehicles.slice(startIndex, startIndex + limitNumber);

      return this.sendSuccessResponse(res, {
        vehicles: paginatedVehicles,
        pagination: {
          total: filteredVehicles.length,
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(filteredVehicles.length / limitNumber)
        }
      });
    } catch (error) {
      this.logger.error('Error fetching vehicles:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch vehicles');
    }
  }

  private async getVehicleById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        return this.sendErrorResponse(res, 400, 'Vehicle ID is required');
      }

      const vehicle = await this.db.getVehicleById(id);

      if (!vehicle) {
        return this.sendErrorResponse(res, 404, 'Vehicle not found');
      }

      // Calculate transaction summary
      const transactionSummary = {
        totalSessions: vehicle.transactions?.length || 0,
        completedSessions: vehicle.transactions?.filter((txn: any) => txn.stopTimestamp).length || 0,
        activeSessions: vehicle.transactions?.filter((txn: any) => !txn.stopTimestamp).length || 0,
        totalEnergyKWh: vehicle.transactions?.reduce((sum: number, txn: any) => {
          const energy = txn.meterStop && txn.meterStart 
            ? (txn.meterStop - txn.meterStart) / 1000 
            : 0;
          return sum + energy;
        }, 0) || 0,
        totalCost: vehicle.transactions?.reduce((sum: number, txn: any) => {
          return sum + (txn.totalAmount || 0);
        }, 0) || 0,
        currency: vehicle.transactions?.[0]?.currency || 'NGN',
        lastChargeDate: vehicle.transactions?.[0]?.startTimestamp || null
      };

      return this.sendSuccessResponse(res, { 
        vehicle,
        transactionSummary
      });
    } catch (error) {
      this.logger.error('Error fetching vehicle:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch vehicle');
    }
  }

  private async createVehicle(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        ownerId,
        fleetId,
        vin,
        licensePlate,
        nickname,
        make,
        model,
        year,
        vehicleType,
        batteryCapacityKWh,
        maxACPowerKW,
        maxDCPowerKW,
        chargingStandards
      } = req.body;

      // Validation
      if (!make || !model || !vehicleType || !batteryCapacityKWh) {
        return this.sendErrorResponse(res, 400, 'Make, model, vehicle type, and battery capacity are required');
      }

      // Map common vehicle type aliases to correct enum values
      const vehicleTypeMapping: Record<string, string> = {
        'EV': 'OTHER',
        'ELECTRIC': 'OTHER',
        'HYBRID': 'OTHER'
      };
      const mappedVehicleType = vehicleTypeMapping[vehicleType] || vehicleType;

      // Validate vehicle type
      const validVehicleTypes = [
        'SEDAN', 'SUV', 'HATCHBACK', 'COUPE', 'CONVERTIBLE',
        'TRUCK', 'VAN', 'MOTORCYCLE', 'BUS', 'OTHER'
      ];
      if (!validVehicleTypes.includes(mappedVehicleType)) {
        return this.sendErrorResponse(res, 400, `Invalid vehicle type. Must be one of: ${validVehicleTypes.join(', ')}`);
      }

      // Map common charging standard aliases to correct enum values
      const chargingStandardMapping: Record<string, string> = {
        'TYPE2': 'TYPE2_AC',
        'CCS': 'CCS2',
        'CHADEMO': 'CHADEMO'
      };

      let mappedChargingStandards = chargingStandards;
      if (chargingStandards && Array.isArray(chargingStandards)) {
        mappedChargingStandards = chargingStandards.map((standard: string) =>
          chargingStandardMapping[standard] || standard
        );
      }

      // Validate charging standards
      const validChargingStandards = [
        'CCS1', 'CCS2', 'CHADEMO', 'TYPE1_AC', 'TYPE2_AC',
        'TESLA_SUPERCHARGER', 'GBT_AC', 'GBT_DC'
      ];
      if (mappedChargingStandards && Array.isArray(mappedChargingStandards)) {
        const invalidStandards = mappedChargingStandards.filter(
          (standard: string) => !validChargingStandards.includes(standard)
        );
        if (invalidStandards.length > 0) {
          return this.sendErrorResponse(res, 400, `Invalid charging standards: ${invalidStandards.join(', ')}. Valid options: ${validChargingStandards.join(', ')}`);
        }
      }

      // Validate battery capacity
      if (batteryCapacityKWh <= 0 || batteryCapacityKWh > 1000) {
        return this.sendErrorResponse(res, 400, 'Battery capacity must be between 0 and 1000 kWh');
      }

      // Validate power ratings if provided
      if (maxACPowerKW && (maxACPowerKW <= 0 || maxACPowerKW > 500)) {
        return this.sendErrorResponse(res, 400, 'Max AC power must be between 0 and 500 kW');
      }
      if (maxDCPowerKW && (maxDCPowerKW <= 0 || maxDCPowerKW > 1000)) {
        return this.sendErrorResponse(res, 400, 'Max DC power must be between 0 and 1000 kW');
      }

      const vehicle = await this.db.createVehicle({
        ownerId,
        fleetId,
        vin,
        licensePlate,
        nickname,
        make,
        model,
        year,
        vehicleType: mappedVehicleType,
        batteryCapacityKWh,
        maxACPowerKW,
        maxDCPowerKW,
        chargingStandards: mappedChargingStandards
      });

      return this.sendSuccessResponse(res, {
        message: 'Vehicle created successfully',
        vehicle
      });
    } catch (error: any) {
      this.logger.error('Error creating vehicle:', error);

      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('vin')) {
          return this.sendErrorResponse(res, 409, 'VIN already exists');
        }
      }

      if (error.message?.includes('cannot belong to both')) {
        return this.sendErrorResponse(res, 400, error.message);
      }

      return this.sendErrorResponse(res, 500, 'Failed to create vehicle');
    }
  }

  private async updateVehicle(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updateData = req.body;
      console.log(updateData)

      if (!id) {
        return this.sendErrorResponse(res, 400, 'Vehicle ID is required');
      }

      // Check if vehicle exists
      const existingVehicle = await this.db.getVehicleById(id);
      if (!existingVehicle) {
        return this.sendErrorResponse(res, 404, 'Vehicle not found');
      }

      // Validate vehicle type if provided
      if (updateData.vehicleType) {
        const validVehicleTypes = [
          'SEDAN', 'SUV', 'HATCHBACK', 'COUPE', 'CONVERTIBLE',
          'TRUCK', 'VAN', 'MOTORCYCLE', 'BUS', 'OTHER'
        ];
        if (!validVehicleTypes.includes(updateData.vehicleType)) {
          return this.sendErrorResponse(res, 400, 'Invalid vehicle type');
        }
      }

      // Validate charging standards if provided
      if (updateData.chargingStandards && Array.isArray(updateData.chargingStandards)) {
        const validChargingStandards = [
          'CCS1', 'CCS2', 'CHADEMO', 'TYPE1_AC', 'TYPE2_AC',
          'TESLA_SUPERCHARGER', 'GBT_AC', 'GBT_DC', 'TYPE2', 'CCS'
        ];
        const invalidStandards = updateData.chargingStandards.filter(
          (standard: string) => !validChargingStandards.includes(standard)
        );
        if (invalidStandards.length > 0) {
          return this.sendErrorResponse(res, 400, `Invalid charging standards: ${invalidStandards.join(', ')}`);
        }
      }

      // Validate numeric fields if provided
      if (updateData.batteryCapacityKWh && (updateData.batteryCapacityKWh <= 0 || updateData.batteryCapacityKWh > 1000)) {
        return this.sendErrorResponse(res, 400, 'Battery capacity must be between 0 and 1000 kWh');
      }
      if (updateData.maxACPowerKW && (updateData.maxACPowerKW <= 0 || updateData.maxACPowerKW > 500)) {
        return this.sendErrorResponse(res, 400, 'Max AC power must be between 0 and 500 kW');
      }
      if (updateData.maxDCPowerKW && (updateData.maxDCPowerKW <= 0 || updateData.maxDCPowerKW > 1000)) {
        return this.sendErrorResponse(res, 400, 'Max DC power must be between 0 and 1000 kW');
      }

      const updatedVehicle = await this.db.updateVehicle(id, updateData);

      return this.sendSuccessResponse(res, {
        message: 'Vehicle updated successfully',
        vehicle: updatedVehicle
      });
    } catch (error: any) {
      this.logger.error('Error updating vehicle:', error);

      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('vin')) {
          return this.sendErrorResponse(res, 409, 'VIN already exists');
        }
      }

      return this.sendErrorResponse(res, 500, 'Failed to update vehicle');
    }
  }

  private async deleteVehicle(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      if (!id) {
        return this.sendErrorResponse(res, 400, 'Vehicle ID is required');
      }

      const deletedVehicle = await this.db.softDeleteVehicle(
        id,
        req.user!.id,
        reason || 'Vehicle deleted by admin'
      );

      return this.sendSuccessResponse(res, {
        message: 'Vehicle deleted successfully',
        vehicle: {
          id: deletedVehicle.id,
          make: deletedVehicle.make,
          model: deletedVehicle.model,
          licensePlate: deletedVehicle.licensePlate,
          status: deletedVehicle.status,
          deletedAt: deletedVehicle.deletedAt
        }
      });
    } catch (error) {
      this.logger.error('Error deleting vehicle:', error);
      return this.sendErrorResponse(res, 500, 'Failed to delete vehicle');
    }
  }

  private async getVehicleTransactions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { 
        page = '1', 
        limit = '20', 
        startDate, 
        endDate,
        sortBy = 'startTimestamp',
        sortOrder = 'desc'
      } = req.query;

      if (!id) {
        return this.sendErrorResponse(res, 400, 'Vehicle ID is required');
      }

      // Check if vehicle exists
      const vehicle = await this.db.getVehicleById(id);
      if (!vehicle) {
        return this.sendErrorResponse(res, 404, 'Vehicle not found');
      }

      const pageNumber = Math.max(1, parseInt(page as string, 10));
      const limitNumber = Math.max(1, Math.min(100, parseInt(limit as string, 10)));

      // Build date filter
      const dateFilter: any = {};
      if (startDate) {
        dateFilter.gte = new Date(startDate as string);
      }
      if (endDate) {
        dateFilter.lte = new Date(endDate as string);
      }

      // Get transactions with pagination
      const result = await this.db.getVehicleTransactions(id, {
        skip: (pageNumber - 1) * limitNumber,
        take: limitNumber,
        startDate: dateFilter.gte,
        endDate: dateFilter.lte,
        sortBy: sortBy as string,
        sortOrder: sortOrder as 'asc' | 'desc'
      });

      // Calculate summary statistics
      const summary = {
        totalSessions: result.total,
        totalEnergyKWh: result.transactions.reduce((sum, txn) => {
          const energy = txn.meterStop && txn.meterStart 
            ? (txn.meterStop - txn.meterStart) / 1000 
            : 0;
          return sum + energy;
        }, 0),
        totalCost: result.transactions.reduce((sum, txn) => {
          return sum + (txn.totalAmount || 0);
        }, 0),
        completedSessions: result.transactions.filter(txn => txn.stopTimestamp).length,
        activeSessions: result.transactions.filter(txn => !txn.stopTimestamp).length,
        averageSessionDuration: this.calculateAverageSessionDuration(result.transactions),
        currency: result.transactions[0]?.currency || 'NGN'
      };

      return this.sendSuccessResponse(res, {
        vehicle: {
          id: vehicle.id,
          make: vehicle.make,
          model: vehicle.model,
          licensePlate: vehicle.licensePlate,
          vin: vehicle.vin
        },
        transactions: result.transactions,
        summary,
        pagination: {
          total: result.total,
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(result.total / limitNumber)
        }
      });
    } catch (error) {
      this.logger.error('Error fetching vehicle transactions:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch vehicle transactions');
    }
  }

  private calculateAverageSessionDuration(transactions: any[]): number {
    const completedTransactions = transactions.filter(txn => 
      txn.startTimestamp && txn.stopTimestamp
    );

    if (completedTransactions.length === 0) return 0;

    const totalDuration = completedTransactions.reduce((sum, txn) => {
      const duration = new Date(txn.stopTimestamp).getTime() - new Date(txn.startTimestamp).getTime();
      return sum + duration;
    }, 0);

    return Math.round(totalDuration / completedTransactions.length / 1000 / 60); // Return in minutes
  }

  // System Settings endpoints
  private async getSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { category, isPublic } = req.query;

      const settings = await this.db.getAllSettings(
        category as string,
        isPublic === 'true' ? true : undefined
      );

      return this.sendSuccessResponse(res, {
        settings,
        total: settings.length
      });
    } catch (error) {
      this.logger.error('Error fetching settings:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch settings');
    }
  }

  private async getPublicSettings(req: Request, res: Response): Promise<void> {
    try {
      const settings = await this.db.getAllSettings(undefined, true);

      // Transform settings for public consumption
      const publicSettings = settings.reduce((acc: any, setting: any) => {
        acc[setting.key] = {
          value: this.parseSettingValue(setting),
          displayName: setting.displayName,
          description: setting.description,
          unit: setting.unit,
          category: setting.category
        };
        return acc;
      }, {});

      return this.sendSuccessResponse(res, publicSettings);
    } catch (error) {
      this.logger.error('Error fetching public settings:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch public settings');
    }
  }

  private async getSettingsByCategory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { category } = req.params;

      if (!category) {
        return this.sendErrorResponse(res, 400, 'Category is required');
      }

      const settings = await this.db.getSettingsByCategory(category.toUpperCase());

      return this.sendSuccessResponse(res, {
        category: category.toUpperCase(),
        settings,
        total: settings.length
      });
    } catch (error) {
      this.logger.error('Error fetching settings by category:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch settings by category');
    }
  }

  private async getSetting(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { key } = req.params;

      if (!key) {
        return this.sendErrorResponse(res, 400, 'Setting key is required');
      }

      const value = await this.db.getSetting(key);

      if (value === null) {
        return this.sendErrorResponse(res, 404, 'Setting not found');
      }

      return this.sendSuccessResponse(res, {
        key,
        value
      });
    } catch (error) {
      this.logger.error('Error fetching setting:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch setting');
    }
  }

  private async createSetting(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        key,
        value,
        dataType,
        category,
        displayName,
        description,
        unit,
        minValue,
        maxValue,
        allowedValues,
        isRequired,
        isPublic,
        isEditable,
        requiresRestart
      } = req.body;

      if (!key || !displayName || value === undefined) {
        return this.sendErrorResponse(res, 400, 'Key, displayName, and value are required');
      }

      const setting = await this.db.createSetting({
        key,
        value,
        dataType,
        category,
        displayName,
        description,
        unit,
        minValue,
        maxValue,
        allowedValues,
        isRequired,
        isPublic,
        isEditable,
        requiresRestart,
        createdBy: req.user!.id
      });

      return this.sendSuccessResponse(res, setting);
    } catch (error: any) {
      this.logger.error('Error creating setting:', error);
      if (error.code === 'P2002') {
        return this.sendErrorResponse(res, 409, 'Setting key already exists');
      }
      return this.sendErrorResponse(res, 500, 'Failed to create setting');
    }
  }

  private async updateSetting(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { key } = req.params;
      const { value, changeReason } = req.body;

      if (!key) {
        return this.sendErrorResponse(res, 400, 'Setting key is required');
      }

      if (value === undefined) {
        return this.sendErrorResponse(res, 400, 'Value is required');
      }

      const setting = await this.db.setSetting(
        key,
        value,
        req.user!.id,
        changeReason
      );

      return this.sendSuccessResponse(res, {
        key,
        value: this.parseSettingValue(setting),
        message: 'Setting updated successfully'
      });
    } catch (error) {
      this.logger.error('Error updating setting:', error);
      return this.sendErrorResponse(res, 500, 'Failed to update setting');
    }
  }

  private async deleteSetting(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { key } = req.params;
      const { reason } = req.body;

      if (!key) {
        return this.sendErrorResponse(res, 400, 'Setting key is required');
      }

      await this.db.deleteSetting(key, req.user!.id, reason);

      return this.sendSuccessResponse(res, {
        message: 'Setting deleted successfully'
      });
    } catch (error) {
      this.logger.error('Error deleting setting:', error);
      return this.sendErrorResponse(res, 500, 'Failed to delete setting');
    }
  }

  private async getSettingHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { key } = req.params;
      const { limit = '50' } = req.query;

      if (!key) {
        return this.sendErrorResponse(res, 400, 'Setting key is required');
      }

      const history = await this.db.getSettingHistory(key, parseInt(limit as string));

      return this.sendSuccessResponse(res, {
        key,
        history,
        total: history.length
      });
    } catch (error) {
      this.logger.error('Error fetching setting history:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch setting history');
    }
  }

  // Quick settings endpoints for common operations
  private async getCurrentPricing(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const [pricePerKWh, currency, taxRate] = await Promise.all([
        this.db.getDefaultPricePerKWh(),
        this.db.getSystemCurrency(),
        this.db.getTaxRate()
      ]);

      return this.sendSuccessResponse(res, {
        pricePerKWh,
        currency,
        taxRate,
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      this.logger.error('Error fetching current pricing:', error);
      return this.sendErrorResponse(res, 500, 'Failed to fetch current pricing');
    }
  }

  private async updatePricePerKWh(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { price, reason } = req.body;

      if (typeof price !== 'number' || price <= 0) {
        return this.sendErrorResponse(res, 400, 'Valid price is required (must be a positive number)');
      }

      if (price > 10) {
        return this.sendErrorResponse(res, 400, 'Price cannot exceed $10.00 per kWh');
      }

      await this.db.setDefaultPricePerKWh(price, req.user!.id);

      // Also update the setting with reason
      await this.db.setSetting(
        'default_price_per_kwh',
        price,
        req.user!.id,
        reason || `Price updated to $${price}/kWh`
      );

      return this.sendSuccessResponse(res, {
        pricePerKWh: price,
        currency: await this.db.getSystemCurrency(),
        updatedBy: req.user!.username,
        updatedAt: new Date().toISOString(),
        message: 'Price per kWh updated successfully'
      });
    } catch (error) {
      this.logger.error('Error updating price per kWh:', error);
      return this.sendErrorResponse(res, 500, 'Failed to update price per kWh');
    }
  }

  // Helper method to parse setting values
  private parseSettingValue(setting: any): any {
    if (!setting) return null;

    switch (setting.dataType) {
      case 'NUMBER':
        return parseFloat(setting.value);
      case 'BOOLEAN':
        return setting.value === 'true';
      case 'JSON':
        try {
          return JSON.parse(setting.value);
        } catch {
          return setting.value;
        }
      default:
        return setting.value;
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
        return this.sendErrorResponse(
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
      return this.sendErrorResponse(
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


  private async updateChargeStation(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { location } = req.body;
    const { chargePointId } = req.params;

    if (!chargePointId) {
      return this.sendErrorResponse(res, 400, "No chargePoint specified")
    }

    const CP = await this.db.getChargePoint(chargePointId)
    if (!CP || CP.id !== chargePointId) {
      return this.sendErrorResponse(res, 404, "No matching charge point found")
    }

    const updateData = {
      id: chargePointId,
      vendor: CP.vendor,
      model: CP.model,
      location: location,
      serialNumber: CP.serialNumber || undefined,
      firmwareVersion: CP.firmwareVersion || undefined,
      iccid: CP.iccid || undefined,
      imsi: CP.imsi || undefined,
      meterType: CP.meterType || undefined,
      meterSerialNumber: CP.meterSerialNumber || undefined
    };

    const chargePointData = await this.db.createOrUpdateChargePoint(updateData);
    if (!chargePointData) {
      return this.sendErrorResponse(res, 500, "Failed to update charge point")
    }
    return this.sendSuccessResponse(res, chargePointData)
  }
}