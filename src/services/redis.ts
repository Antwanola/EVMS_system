import { createClient, RedisClientType } from 'redis';
import { Logger } from '../Utils/logger';

export class RedisService {
  private client: RedisClientType;
  private logger = Logger.getInstance();

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });

    this.client.on('error', (error) => {
      this.logger.error('Redis client error:', error);
    });

    this.client.on('connect', () => {
      this.logger.info('Connected to Redis');
    });
  }

  public async connect(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.info('Redis connection established');
    } catch (error) {
      this.logger.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
      this.logger.info('Disconnected from Redis');
    } catch (error) {
      this.logger.error('Error disconnecting from Redis:', error);
    }
  }

  /**
   * Set a string value in Redis
   */
  public async set(key: string, value: string, ttl?: number): Promise<void> {
    try {
      // Validate that value is a string
      if (typeof value !== 'string') {
        throw new TypeError(`Value must be a string, got ${typeof value}`);
      }

      if (ttl) {
        await this.client.set(key, value, { EX: ttl });
      } else {
        await this.client.set(key, value);
      }
    } catch (error) {
      this.logger.error(`Error setting Redis key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Set a JSON object in Redis (automatically stringified)
   */
  public async setJSON(key: string, value: any, ttl?: number): Promise<void> {
    try {
      const stringValue = JSON.stringify(value);
      await this.set(key, stringValue, ttl);
    } catch (error) {
      this.logger.error(`Error setting JSON in Redis key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Get a string value from Redis
   */
  public async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      this.logger.error(`Error getting Redis key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Get and parse a JSON object from Redis
   */
  public async getJSON<T = any>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      this.logger.error(`Error getting JSON from Redis key ${key}:`, error);
      throw error;
    }
  }

  public async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.error(`Error deleting Redis key ${key}:`, error);
      throw error;
    }
  }

  public async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      this.logger.error('Redis ping failed:', error);
      return false;
    }
  }

  public getClient(): RedisClientType {
    return this.client;
  }
}