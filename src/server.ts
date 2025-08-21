import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { Logger } from './Utils/logger';
import { OCPPServer } from './services/ocpp_server';
import { APIGateway } from './services/api_gateway';
import { DatabaseService } from './services/database';
import { RedisService } from './services/redis';
import { InitialSeed } from './newSeed';

dotenv.config();

const logger = Logger.getInstance();

class Application {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer;
  private ocppServer: OCPPServer;
  private apiGateway: APIGateway;
  private db: DatabaseService;
  private redis: RedisService;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    
    this.db = new DatabaseService();
    this.redis = new RedisService();
    this.ocppServer = new OCPPServer(this.wss, this.db, this.redis);
    this.apiGateway = new APIGateway(this.ocppServer, this.db);
  }

  private setupMiddleware(): void {
    this.app.use(helmet());
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
      credentials: true
    }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
  }

  private setupRoutes(): void {
    this.app.use('/api/v1', this.apiGateway.getRouter());
    
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connectedChargePoints: this.ocppServer.getConnectedChargePoints().length
      });
    });
  }

  private async initialize(): Promise<void> {
    await this.db.connect();
    await this.redis.connect();
    
    this.setupMiddleware();
    this.setupRoutes();
    
    this.ocppServer.initialize();
    await InitialSeed()

    // Graceful shutdown
    process.on('SIGTERM', this.shutdown.bind(this));
    process.on('SIGINT', this.shutdown.bind(this));
  }

  private async shutdown(): Promise<void> {
    logger.info('Shutting down server...');
    
    this.server.close(() => {
      logger.info('HTTP server closed');
    });
    
    this.wss.close(() => {
      logger.info('WebSocket server closed');
    });
    
    await this.db.disconnect();
    await this.redis.disconnect();
    
    process.exit(0);
  }

  public async start(port: number = parseInt(process.env.PORT || '3000')): Promise<void> {
    await this.initialize();
    
    this.server.listen(port, () => {
      logger.info(`OCPP 1.6J Server running on port ${port}`);
      logger.info(`WebSocket endpoint: ws://localhost:${port}/`);
      logger.info(`API Gateway: http://localhost:${port}/api/v1`);
    });
  }
}

// Start the application
const app = new Application();
app.start().catch((error) => {
  Logger.getInstance().error('Failed to start server:', error);
  process.exit(1);
});