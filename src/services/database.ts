// src/services/database.ts
import { PrismaClient, ChargePoint, Connector, ConnectorStatus, Transaction, ChargingData, User, Alarm } from '@prisma/client';
import { Logger } from '../Utils/logger';
import { ChargingStationData, ConnectorType, ChargePointStatus, StopReason } from '../types/ocpp_types';
import { UserWithRelations } from '../types/userWithRelations';
import { schemas } from '../middleware/validation';

export class DatabaseService {
  private prisma: PrismaClient;
  private logger = Logger.getInstance();

  constructor() {
    this.prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
    });
  }

  public async connect(): Promise<void> {
    try {
      await this.prisma.$connect();
      this.logger.info('Connected to PostgreSQL database');
    } catch (error) {
      this.logger.error('Failed to connect to database:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await this.prisma.$disconnect();
      this.logger.info('Disconnected from database');
    } catch (error) {
      this.logger.error('Error disconnecting from database:', error);
    }
  }

  // Charge Point Management
  public async createOrUpdateChargePoint(data: {
    id: string;
    vendor: string;
    model: string;
    serialNumber?: string;
    firmwareVersion?: string;
    iccid?: string;
    imsi?: string;
    meterType?: string;
    meterSerialNumber?: string;
  }): Promise<ChargePoint> {
    return this.prisma.chargePoint.upsert({
      where: { id: data.id },
      update: {
        vendor: data.vendor,
        model: data.model,
        serialNumber: data.serialNumber,
        firmwareVersion: data.firmwareVersion,
        iccid: data.iccid,
        imsi: data.imsi,
        meterType: data.meterType,
        meterSerialNumber: data.meterSerialNumber,
        isOnline: true,
        lastSeen: new Date(),
        updatedAt: new Date(),
      },
      create: {
        id: data.id,
        vendor: data.vendor,
        model: data.model,
        serialNumber: data.serialNumber,
        firmwareVersion: data.firmwareVersion,
        iccid: data.iccid,
        imsi: data.imsi,
        meterType: data.meterType,
        meterSerialNumber: data.meterSerialNumber,
        isOnline: true,
        lastSeen: new Date(),
      },
    });
  }

  public async updateChargePointStatus(chargePointId: string, isOnline: boolean): Promise<void> {
    await this.prisma.chargePoint.update({
      where: { id: chargePointId },
      data: {
        isOnline,
        lastSeen: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  public async getChargePoint(id: string): Promise<ChargePoint | null> {
    return this.prisma.chargePoint.findUnique({
      where: { id },
      include: {
        connectors: true,
        configurations: true,
      },
    });
  }

  public async getAllChargePoints(): Promise<ChargePoint[]> {
    return this.prisma.chargePoint.findMany({
      include: {
        connectors: true,
      },
    });
  }

  // Connector Management
  public async createOrUpdateConnector(
    chargePointId: string,
    connectorId: number,
    data: Partial<Connector>
  ): Promise<Connector> {
    return this.prisma.connector.upsert({
      where: {
        chargePointId_connectorId: {
          chargePointId,
          connectorId,
        },
      },
      update: {
        ...data,
        lastUpdated: new Date(),
        updatedAt: new Date(),
      },
      create: {
        chargePointId,
        connectorId,
        type: (data.type as any) || 'TYPE2',
        status: (data.status as any) || ConnectorStatus.AVAILABLE,
        ...data,
      },
    });
  }

  public async updateConnectorStatus(
    chargePointId: string,
    connectorId: number,
    status: ChargePointStatus,
    errorCode?: string,
    vendorErrorCode?: string
  ): Promise<void> {
    const normalisedStatus = status.toUpperCase() as ChargePointStatus
    await this.prisma.connector.upsert({
      where: {
        chargePointId_connectorId: {
          chargePointId,
          connectorId,
        },
      },
      update: {
        status: ConnectorStatus[normalisedStatus] || ConnectorStatus.AVAILABLE,
        errorCode,
        vendorErrorCode,
        lastUpdated: new Date(),
        updatedAt: new Date(),
      },
      create: {
      chargePointId,
      connectorId,
      type: ConnectorType.TYPE2, // or infer from station if available
      status: ConnectorStatus[normalisedStatus] || ConnectorStatus.AVAILABLE,
      errorCode,
      lastUpdated: new Date(),
    },
    });
  }

  public async getConnector(chargePointId: string, connectorId: number): Promise<Connector | null> {
    return this.prisma.connector.findUnique({
      where: {
        chargePointId_connectorId: {
          chargePointId,
          connectorId,
        },
      },
    });
  }

  // Transaction Management
  public async createTransaction(data: {
    transactionId: number;
    chargePointId: string;
    connectorId: number;
    idTag: string;
    meterStart: number;
    startTimestamp: Date;
    reservationId?: number;
  }): Promise<Transaction> {
    return this.prisma.transaction.create({
      data,
    });
  }

  public async stopTransaction(
    transactionId: number,
    meterStop: number,
    stopTimestamp: Date,
    stopReason?: StopReason
  ): Promise<Transaction> {
    return this.prisma.transaction.update({
      where: { transactionId },
      data: {
        meterStop,
        stopTimestamp,
        stopReason,
        updatedAt: new Date(),
      },
    });
  }

  public async getTransaction(transactionId: number): Promise<Transaction | null> {
    return this.prisma.transaction.findUnique({
      where: { transactionId },
      include: {
        chargePoint: true,
        connector: true,
        meterValues: {
          include: {
            sampledValues: true,
          },
        },
      },
    });
  }

  public async getActiveTransactions(chargePointId?: string): Promise<Transaction[]> {
    return this.prisma.transaction.findMany({
      where: {
        stopTimestamp: null,
        ...(chargePointId && { chargePointId }),
      },
      include: {
        chargePoint: true,
        connector: true,
      },
    });
  }

  // Charging Data Management
  public async saveChargingData(data: ChargingStationData): Promise<ChargingData> {
    return this.prisma.chargingData.create({
      data: {
        chargePointId: data.chargePointId,
        connectorId: data.connectorId,
        gunType: data.gunType,
        status: ConnectorStatus[data.status] || ConnectorStatus.AVAILABLE,
        inputVoltage: data.inputVoltage,
        inputCurrent: data.inputCurrent,
        outputContactors: data.outputContactors,
        outputVoltage: data.outputVoltage,
        outputEnergy: data.outputEnergy,
        chargingEnergy: data.chargingEnergy,
        alarm: data.alarm,
        stopReason: data.stopReason,
        connected: data.connected,
        gunTemperature: data.gunTemperature,
        stateOfCharge: data.stateOfCharge,
        chargeTime: data.chargeTime,
        remainingTime: data.remainingTime,
        demandCurrent: data.demandCurrent,
        timestamp: data.timestamp,
      },
    });
  }

  public async getChargingDataHistory(
    chargePointId: string,
    connectorId?: number,
    startDate?: Date,
    endDate?: Date,
    limit: number = 1000
  ): Promise<ChargingData[]> {
    return this.prisma.chargingData.findMany({
      where: {
        chargePointId,
        ...(connectorId && { connectorId }),
        ...(startDate && { timestamp: { gte: startDate } }),
        ...(endDate && { timestamp: { lte: endDate } }),
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  public async getLatestChargingData(chargePointId: string, connectorId: number): Promise<ChargingData | null> {
    return this.prisma.chargingData.findFirst({
      where: {
        chargePointId,
        connectorId,
      },
      orderBy: { timestamp: 'desc' },
    });
  }

  // Meter Values Management
  public async saveMeterValues(data: {
    transactionId?: number | null;
    connectorId: number;
    chargePointId: string;
    timestamp: Date;
    sampledValues: Array<{
      value: string;
      context?: string;
      format?: string;
      measurand?: string;
      phase?: string;
      location?: string;
      unit?: string;
    }>;
  }): Promise<void> {
    await this.prisma.meterValue.create({
      data: {
        transactionId: data.transactionId?? null,
        connectorId: data.connectorId,
        chargePointId: data.chargePointId,
        timestamp: data.timestamp,
        sampledValues: {
          create: data.sampledValues,
        },
      },
    });
  }

  // User Management
  public async createUser(data: {
    username: string;
    email: string;
    password: string;
    role: 'ADMIN' | 'OPERATOR' | 'VIEWER' | 'THIRD_PARTY';
  }): Promise<User> {
    return this.prisma.user.create({
      data,
    });
  }

  public async getUserByEmail(email: string): Promise<UserWithRelations | null> {
    return this.prisma.user.findUnique({
      where: { email },
      include: {
        permissions: true,
        chargePointAccess: true,
      },
    });
  }

  public async getUserByApiKey(apiKey: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { apiKey },
      include: {
        permissions: true,
        chargePointAccess: true,
      },
    });
  }

  // Configuration Management
  public async getChargePointConfiguration(chargePointId: string, key?: string): Promise<any[]> {
    return this.prisma.chargePointConfiguration.findMany({
      where: {
        chargePointId,
        ...(key && { key }),
      },
    });
  }

  public async setChargePointConfiguration(
    chargePointId: string,
    key: string,
    value: string,
    readonly: boolean = false
  ): Promise<void> {
    await this.prisma.chargePointConfiguration.upsert({
      where: {
        chargePointId_key: {
          chargePointId,
          key,
        },
      },
      update: { value },
      create: {
        chargePointId,
        key,
        value,
        readonly,
      },
    });
  }

  // Alarm Management
  public async createAlarm(data: {
    chargePointId: string;
    connectorId?: number;
    alarmType: string;
    severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
    message: string;
  }): Promise<Alarm> {
    return this.prisma.alarm.create({
      data,
    });
  }

  public async resolveAlarm(id: string, resolvedBy: string): Promise<Alarm> {
    return this.prisma.alarm.update({
      where: { id },
      data: {
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy,
        updatedAt: new Date(),
      },
    });
  }

  public async getActiveAlarms(chargePointId?: string): Promise<Alarm[]> {
    return this.prisma.alarm.findMany({
      where: {
        resolved: false,
        ...(chargePointId && { chargePointId }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Analytics and Reporting
  public async getChargingStatistics(
    chargePointId?: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<any> {
    const where = {
      ...(chargePointId && { chargePointId }),
      ...(startDate && { timestamp: { gte: startDate } }),
      ...(endDate && { timestamp: { lte: endDate } }),
    };

    const [
      totalSessions,
      totalEnergy,
      averageSessionTime,
      peakPower
    ] = await Promise.all([
      this.prisma.transaction.count({ where: { ...where, stopTimestamp: { not: null } } }),
      this.prisma.chargingData.aggregate({
        where,
        _sum: { chargingEnergy: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...where, stopTimestamp: { not: null } },
        _avg: { meterStop: true },
      }),
      this.prisma.chargingData.aggregate({
        where,
        _max: { outputEnergy: true },
      }),
    ]);

    return {
      totalSessions,
      totalEnergy: totalEnergy._sum.chargingEnergy || 0,
      averageSessionTime: averageSessionTime._avg.meterStop || 0,
      peakPower: peakPower._max.outputEnergy || 0,
    };
  }

  // ID Tag Management
  public async validateIdTag(idTag: string): Promise<{ status: string; expiryDate?: Date }> {
    const tag = await this.prisma.idTag.findUnique({
      where: { idTag },
    });

    if (!tag) {
      return { status: 'INVALID' };
    }

    if (tag.expiryDate && tag.expiryDate < new Date()) {
      return { status: 'EXPIRED', expiryDate: tag.expiryDate };
    }

    return { 
      status: tag.status, 
      expiryDate: tag.expiryDate || undefined 
    };
  }

  public async createIdTag(data: {
    idTag: string;
    parentIdTag?: string;
    status?: 'ACCEPTED' | 'BLOCKED' | 'EXPIRED' | 'INVALID' | 'CONCURRENT_TX';
    expiryDate?: Date;
  }): Promise<void> {
    await this.prisma.idTag.create({
      data: {
        idTag: data.idTag,
        parentIdTag: data.parentIdTag,
        status: data.status || 'ACCEPTED',
        expiryDate: data.expiryDate,
      },
    });
  }

  // Utility methods
  public async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('Database health check failed:', error);
      return false;
    }
  }

  public getPrismaClient(): PrismaClient {
    return this.prisma;
  }
}