// src/services/database.ts
import { PrismaClient, Prisma, ChargePoint, Connector, User, Transaction, IdTag, ConnectorStatus, ChargingData, Alarm } from '@prisma/client';
import { Logger } from '../Utils/logger';
import { ChargingStationData, ConnectorType, ChargePointStatus, StopReason, CreatedTransactionResult } from '../types/ocpp_types';
import { UserSecureWithRelations, UserWithRelations } from '../types/userWithRelations';
import { schemas } from '../middleware/validation';

export class DatabaseService {
  private prisma: PrismaClient;
  private logger = Logger.getInstance();
  private ChargePoint;

  constructor() {
    this.prisma = new PrismaClient({
      // log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
      datasourceUrl: process.env.DATABASE_URL
    });
    this.ChargePoint = this.prisma.chargePoint
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


  public async getIdTag(idTag: string): Promise<IdTag | null> {
    const foundItem = await this.prisma.idTag.findUnique({
      where: { idTag}
    })
    return foundItem;
  }

 public async updateChargePointStatus(chargePointId: string, isOnline: boolean): Promise<void> {
  await this.prisma.chargePoint.upsert({
    where: { id: chargePointId },
    update: {
      isOnline,
      lastSeen: new Date(),
      updatedAt: new Date(),
    },
    create: {
      id: chargePointId,
      vendor: 'Unknown',       // provide default values
      model: 'Unknown',        // provide default values
      isOnline,
      lastSeen: new Date(),
      createdAt: new Date(),
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

  public async getAllChargePoints(): Promise<(ChargePoint & { connectors: Connector[] })[]> {
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
    data: Partial<Connector>,
    transactionId?: number
  ): Promise<Connector> {
    return this.prisma.connector.upsert({
      where: {
        chargePointId_connectorId: {
          chargePointId,
          connectorId,
        },
      },
      update: {
        // ...data,
        currentTransactionId: transactionId ?? undefined,
        lastUpdated: new Date(),
        updatedAt: new Date(),
      },
      create: {
        chargePointId,
        connectorId,
        type: (data.type as any) || 'TYPE2',
        status: (data.status as any) || ConnectorStatus.UNAVAILABLE,
        currentTransactionId: transactionId ?? undefined,
        lastUpdated: new Date(),
        createdAt: new Date(),
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
        status: ConnectorStatus[normalisedStatus] ? ConnectorStatus[normalisedStatus] : ConnectorStatus.UNAVAILABLE,
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

  public async getConnectorsByChargePointId(chargePointId: string): Promise<Connector[]> {
    return this.prisma.connector.findMany({
      where: {
        chargePointId,
      },
      orderBy: {
        connectorId: 'asc',
      },
    });
  }



public async createTransaction(data: {
  transactionId: number;
  chargePointId: string;
  connectorId: number;
  idTag: string;
  meterStart: number;
  startTimestamp: Date;
  reservationId?: number;
}): Promise<CreatedTransactionResult> { // <-- Updated return type for clarity

  const idTagRecord = await this.prisma.idTag.findUnique({
      where: {
        idTag: data.idTag, // Lookup using the physical tag value
      },
      select: { id: true },
  });

  const idTagDbId = idTagRecord?.id;

  const transactionCreationData: Prisma.TransactionCreateInput = {
      // 1. Scalar Fields
      transactionId: data.transactionId,
      meterStart: data.meterStart,
      startTimestamp: data.startTimestamp,
      reservationId: data.reservationId,
      
      // 2. Relations using connect
      chargePoint: { connect: { id: data.chargePointId } }, 
      connector: {
        connect: {
          chargePointId_connectorId: {
            chargePointId: data.chargePointId,
            connectorId: data.connectorId,
          },
        },
      },
      // Use the database ID for the relation:
      ...(idTagDbId && { idTag: { connect: { id: idTagDbId } } }),
  }
  
  return this.prisma.transaction.create({
      data: transactionCreationData,
      // 🎯 CORRECTION: Use SELECT to explicitly return the OCPP transactionId
      select: {
          id: true, // Internal DB Primary Key (often needed later)
          transactionId: true, // <-- The crucial OCPP ID number for the Connector update
          startTimestamp: true, // Useful for logs/next steps
      }
  });
}

  public async stopTransaction(
    transactionId: number,
    meterStop: number,
    stopTimestamp: Date,
    stopReason?: StopReason,
    stopSoC?: number | null
  ): Promise<Transaction> {
    return await this.prisma.transaction.update({
      where: { transactionId },
      data: {
        meterStop,
        stopTimestamp,
        stopReason,
        ...(stopSoC !== undefined && { stopSoC }),
        updatedAt: new Date(),
      },
    });
  }

//   public async writeSOCToTXN( transactionId: number, soc: number): Promise<Transaction> {
//     return await this.prisma.transaction.update({
//       where: { transactionId, startSoC: null },
//       data: { startSoC: soc },
//   });
// }

public async writeStartSOCToTXN(transactionId: number, soc: number): Promise<Transaction> {
  try {
    // First check if transaction exists
    const existingTransaction = await this.prisma.transaction.findUnique({
      where: { transactionId },
    });

    if (!existingTransaction) {
      console.error(`❌ Transaction ${transactionId} not found in database`);
      throw new Error(`Transaction ${transactionId} does not exist`);
    }

    console.log(`✅ Found transaction ${transactionId}, updating startSoC to ${soc}%`);

    // Update the transaction with SOC value
    // Use only transactionId in where clause, not startSoC condition
    return await this.prisma.transaction.update({
      where: { transactionId },
      data: { 
        startSoC: soc,
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    console.error(`❌ Error writing startSoC to transaction ${transactionId}:`, error);
    throw error;
  }
}

public async writeStopSOCToTXN(transactionId: number, stopSoC: number): Promise<Transaction> {
  try {
    // First check if transaction exists
    const existingTransaction = await this.prisma.transaction.findUnique({
      where: { transactionId },
    });

    if (!existingTransaction) {
      console.error(`❌ Transaction ${transactionId} not found in database`);
      throw new Error(`Transaction ${transactionId} does not exist`);
    }

    console.log(`✅ Found transaction ${transactionId}, updating stopSoC to ${stopSoC}%`);

    // Update the transaction with stopSoC value
    return await this.prisma.transaction.update({
      where: { transactionId },
      data: { 
        stopSoC: stopSoC,
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    console.error(`❌ Error writing stopSoC to transaction ${transactionId}:`, error);
    throw error;
  }
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

 public async getTransactions(options?: {
  skip?: number;
  take?: number;
  where?: any;
  orderBy?: any;
}): Promise<Transaction[]> {
  return this.prisma.transaction.findMany({
    skip: options?.skip,
    take: options?.take,
    where: options?.where,
    orderBy: options?.orderBy,
    include: {
      idTag: true,
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

public async getTransactionsCount(where?: any): Promise<number> {
  return this.prisma.transaction.count({ where });
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
        status: ConnectorStatus[data.status] || ConnectorStatus.UNAVAILABLE,
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

public async setMeterValuesUnderTXN(
  transactionPrimaryKeyId: number,
  meterValues: {
    timestamp: Date;
    connectorId: number;
    chargePointId: string;
    sampledValues: {
      value: string;
      context?: string | null;
      format?: string | null;
      measurand?: string | null;
      phase?: string | null;
      location?: string | null;
      unit?: string | null;
    }[];
  }[]
): Promise<void> {
  await this.prisma.transaction.update({
    where: { id: transactionPrimaryKeyId }, // IMPORTANT: use Transaction.id (PK)
    data: {
      meterValues: {
        create: meterValues.map((mv) => ({
          timestamp: mv.timestamp,
          connectorId: mv.connectorId,
          chargePointId: mv.chargePointId,
          sampledValues: {
            create: mv.sampledValues.map((sv) => ({
              value: sv.value,
              context: sv.context ?? null,
              format: sv.format ?? null,
              measurand: sv.measurand ?? null,
              phase: sv.phase ?? null,
              location: sv.location ?? null,
              unit: sv.unit ?? null,
            })),
          },
        })),
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
  phone?: string;
  firstname?: string;
  lastname?: string;
  isActive?: boolean;
  status?: string;
  idTags?: string;  // Changed from idTag to idTags
}): Promise<User> {
  return this.prisma.user.create({
    data,
  });
}

public async getUserById(id: string): Promise<UserSecureWithRelations | null> {
  return this.prisma.user.findUnique({
    where: { id },
    include: {
      idTag: true,               // ✅ must match schema
      permissions: true,
      chargePointAccess: true,
    },
  });
}


public async getUserByEmail(email: string): Promise<UserWithRelations | null> {
  return this.prisma.user.findUnique({
    where: { email },
    include: {
      idTag: true,
      permissions: true,
      chargePointAccess: true,
    },
  });
}

  public async getUserByApiKey(apiKey: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { apiKey },
      include: {
        idTag: true,
        permissions: true,
        chargePointAccess: true,
      },
    });
  }


//   public async updateUser(email: string, data: Partial<User>): Promise<UserWithRelations | null> {
//   return this.prisma.user.update({
//     where: { email },
//     data,
//     include: {
//       permissions: true,
//       chargePointAccess: true,
//     },
//   });
// }


public async updateUser(email: string, data: Partial<User>): Promise<UserWithRelations | null> {
  // Extract idTag from data since it needs special handling
  const { idTag, idTagId, ...userData } = data as any;
  
  // Build the update data object
  const updateData: any = { ...userData };
  
  // Handle idTag relation if an idTag string is provided
  if (idTag !== undefined) {
    if (idTag === null || idTag === '') {
      // Disconnect the relation if idTag is null or empty
      updateData.idTag = {
        disconnect: true
      };
    } else {
      // connectOrCreate will create the IdTag if it doesn't exist
      updateData.idTag = {
        connectOrCreate: {
          where: { idTag: idTag },
          create: { 
            idTag: idTag,
            status: 'ACCEPTED',
            // expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year from now
          }
        }
      };
    }
  }
  
  return this.prisma.user.update({
    where: { email },
    data: updateData,
    include: {
      permissions: true,
      chargePointAccess: true,
      idTag: true
    },
  });
}





public async getAllUsers(): Promise<UserWithRelations[]> {
  return this.prisma.user.findMany({
    include: {
      idTag: true,
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
      return { status: 'Invalid' };
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
  }): Promise<IdTag> {
    const tag = await this.prisma.idTag.create({
      data: {
        idTag: data.idTag,
        parentIdTag: data.parentIdTag,
        status: data.status || 'ACCEPTED',
        expiryDate: data.expiryDate,
      },
    });

    return tag
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