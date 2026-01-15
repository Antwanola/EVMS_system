// src/services/database.ts
import { PrismaClient, Prisma, ChargePoint, Connector, User, Transaction, IdTag, ConnectorStatus, ChargingData, Alarm, Fleet, FleetManager, Vehicle, SystemSettings, SettingsHistory } from '@prisma/client';
import { Logger } from '../Utils/logger';
import { ChargingStationData, ConnectorType, ChargePointStatus, StopReason, CreatedTransactionResult } from '../types/ocpp_types';
import { UserSecureWithRelations, UserWithRelations } from '../types/userWithRelations';
import { schemas } from '../middleware/validation';
import { Console } from 'console';

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
    location?: string;
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
        location: data.location,
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
        location: data.location,
        isOnline: true,
        lastSeen: new Date(),
      },
    });
  }


  public async getUserByIdTag(idTag: string): Promise<(IdTag & { user: User | null }) | null> {
    return await this.prisma.idTag.findUnique({
      where: { idTag },
      include: {
        user: true
      }
    })
  }

  public async getIdTag(idTag: string): Promise<IdTag | null> {
    return await this.prisma.idTag.findUnique({
      where: { idTag },
      include: {
        user: true
      }
    });
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
  vehicleId?: string
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
      select: {
          id: true, 
          transactionId: true, 
          startTimestamp: true,
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
      idTag: {
        include: {
          user: true
        }
      },
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
      idTag: true,
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

  // Vehicle Management
  public async getAllVehicles(): Promise<any[]> {
    return this.prisma.vehicle.findMany({
      where: { isActive: true },
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            email: true,
            firstname: true,
            lastname: true,
          },
        },
        fleet: {
          select: {
            id: true,
            name: true,
            organizationName: true,
            fleetType: true,
          },
        },
        transactions: {
          include: {
            chargePoint: true,
            connector: true,
            idTag: {
              include: {
                user: {
                  select: {
                    id: true,
                    username: true,
                    email: true,
                  },
                },
              },
            },
          },
          orderBy: {
            startTimestamp: 'desc',
          },
          take: 10, // Limit to last 10 transactions to avoid performance issues
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  public async getVehicleById(id: string): Promise<any | null> {
    return this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            email: true,
            firstname: true,
            lastname: true,
          },
        },
        fleet: {
          select: {
            id: true,
            name: true,
            organizationName: true,
            fleetType: true,
          },
        },
        transactions: {
          include: {
            chargePoint: true,
            connector: true,
            idTag: {
              include: {
                user: {
                  select: {
                    id: true,
                    username: true,
                    email: true,
                  },
                },
              },
            },
          },
          orderBy: {
            startTimestamp: 'desc',
          },
        },
      },
    });
  }

  public async createVehicle(data: {
    ownerId?: string;
    fleetId?: string;
    vin?: string;
    licensePlate?: string;
    nickname?: string;
    make: string;
    model: string;
    year?: number;
    vehicleType: 'SEDAN' | 'SUV' | 'HATCHBACK' | 'COUPE' | 'CONVERTIBLE' | 'TRUCK' | 'VAN' | 'MOTORCYCLE' | 'BUS' | 'OTHER';
    batteryCapacityKWh: number;
    maxACPowerKW?: number;
    maxDCPowerKW?: number;
    chargingStandards?: ('CCS1' | 'CCS2' | 'CHADEMO' | 'TYPE1_AC' | 'TYPE2_AC' | 'TESLA_SUPERCHARGER' | 'GBT_AC' | 'GBT_DC')[];
  }): Promise<any> {
    console.log("FLEET ID", data.fleetId);
    console.log("OWNER ID", data.ownerId);

    // Normalize empty strings to null/undefined
    const ownerId = data.ownerId && data.ownerId.trim() !== '' ? data.ownerId : null;
    const fleetId = data.fleetId && data.fleetId.trim() !== '' ? data.fleetId : null;

    console.log("NORMALIZED - FLEET ID", fleetId);
    console.log("NORMALIZED - OWNER ID", ownerId);

    // Validate that vehicle belongs to either individual OR fleet, not both
    if (ownerId && fleetId) {
      throw new Error('Vehicle cannot belong to both individual owner and fleet');
    }
    if (!ownerId && !fleetId) {
      throw new Error('Vehicle must belong to either individual owner or fleet');
    }

    // Build the data object with normalized values
    const createData = {
      ...data,
      ownerId: ownerId,
      fleetId: fleetId,
      originalOwnerId: ownerId,
      originalFleetId: fleetId,
    };

    return this.prisma.vehicle.create({
      data: createData,
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            email: true,
            firstname: true,
            lastname: true,
          },
        },
        fleet: {
          select: {
            id: true,
            name: true,
            organizationName: true,
            fleetType: true,
          },
        },
      },
    });
  }

  public async updateVehicle(id: string, data: Partial<any>): Promise<any> {
    return this.prisma.vehicle.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date(),
      },
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            email: true,
            firstname: true,
            lastname: true,
          },
        },
        fleet: {
          select: {
            id: true,
            name: true,
            organizationName: true,
            fleetType: true,
          },
        },
      },
    });
  }

  public async softDeleteVehicle(id: string, deletedBy: string, reason?: string): Promise<any> {
    return this.prisma.vehicle.update({
      where: { id },
      data: {
        isActive: false,
        status: 'Deleted',
        deletedAt: new Date(),
        deletedBy,
        deleteReason: reason,
        updatedAt: new Date(),
      },
    });
  }

  public async getVehicleTransactions(
    vehicleId: string,
    options?: {
      skip?: number;
      take?: number;
      startDate?: Date;
      endDate?: Date;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    }
  ): Promise<{ transactions: any[]; total: number }> {
    const where: any = {
      vehicleId,
    };

    // Add date filters if provided
    if (options?.startDate || options?.endDate) {
      where.startTimestamp = {};
      if (options.startDate) {
        where.startTimestamp.gte = options.startDate;
      }
      if (options.endDate) {
        where.startTimestamp.lte = options.endDate;
      }
    }

    // Build orderBy
    const orderBy: any = {};
    const sortBy = options?.sortBy || 'startTimestamp';
    const sortOrder = options?.sortOrder || 'desc';
    orderBy[sortBy] = sortOrder;

    // Get transactions with count
    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        skip: options?.skip,
        take: options?.take,
        orderBy,
        include: {
          chargePoint: {
            select: {
              id: true,
              name: true,
              location: true,
              vendor: true,
              model: true,
            },
          },
          connector: {
            select: {
              connectorId: true,
              type: true,
              status: true,
            },
          },
          idTag: {
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  email: true,
                  firstname: true,
                  lastname: true,
                },
              },
            },
          },
          vehicle: {
            select: {
              id: true,
              make: true,
              model: true,
              licensePlate: true,
              vin: true,
            },
          },
          meterValues: {
            include: {
              sampledValues: true,
            },
            orderBy: {
              timestamp: 'asc',
            },
          },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return { transactions, total };
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

  // System Settings Management
  public async getSetting(key: string): Promise<any | null> {
    const setting = await this.prisma.systemSettings.findUnique({
      where: { key },
    });

    if (!setting) return null;

    // Parse value based on data type
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

  public async setSetting(
    key: string,
    value: any,
    changedBy: string,
    changeReason?: string
  ): Promise<any> {
    // Get current setting for history
    const currentSetting = await this.prisma.systemSettings.findUnique({
      where: { key },
    });

    // Convert value to string for storage
    let stringValue: string;
    if (typeof value === 'object') {
      stringValue = JSON.stringify(value);
    } else {
      stringValue = String(value);
    }

    // Record history if setting exists
    if (currentSetting) {
      await this.prisma.settingsHistory.create({
        data: {
          settingKey: key,
          oldValue: currentSetting.value,
          newValue: stringValue,
          changedBy,
          changeReason,
        },
      });
    }

    // Update or create setting
    return this.prisma.systemSettings.upsert({
      where: { key },
      update: {
        value: stringValue,
        lastModifiedBy: changedBy,
        lastModifiedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        key,
        value: stringValue,
        dataType: this.inferDataType(value),
        category: 'GENERAL',
        displayName: this.formatDisplayName(key),
        lastModifiedBy: changedBy,
      },
    });
  }

  public async getAllSettings(category?: string, isPublic?: boolean): Promise<any[]> {
    return this.prisma.systemSettings.findMany({
      where: {
        ...(category && { category: category as any }),
        ...(isPublic !== undefined && { isPublic }),
      },
      orderBy: [
        { category: 'asc' },
        { displayName: 'asc' },
      ],
    });
  }

  public async getSettingsByCategory(category: string): Promise<any[]> {
    return this.prisma.systemSettings.findMany({
      where: { category: category as any },
      orderBy: { displayName: 'asc' },
    });
  }

  public async createSetting(data: {
    key: string;
    value: any;
    dataType?: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON' | 'EMAIL' | 'URL' | 'PASSWORD';
    category?: string;
    displayName: string;
    description?: string;
    unit?: string;
    minValue?: number;
    maxValue?: number;
    allowedValues?: string[];
    isRequired?: boolean;
    isPublic?: boolean;
    isEditable?: boolean;
    requiresRestart?: boolean;
    createdBy: string;
  }): Promise<any> {
    const stringValue = typeof data.value === 'object' 
      ? JSON.stringify(data.value) 
      : String(data.value);

    return this.prisma.systemSettings.create({
      data: {
        key: data.key,
        value: stringValue,
        dataType: data.dataType || this.inferDataType(data.value),
        category: (data.category as any) || 'GENERAL',
        displayName: data.displayName,
        description: data.description,
        unit: data.unit,
        minValue: data.minValue,
        maxValue: data.maxValue,
        allowedValues: data.allowedValues ? JSON.stringify(data.allowedValues) : null,
        isRequired: data.isRequired || false,
        isPublic: data.isPublic || false,
        isEditable: data.isEditable !== false,
        requiresRestart: data.requiresRestart || false,
        lastModifiedBy: data.createdBy,
      },
    });
  }

  public async getSettingHistory(key: string, limit: number = 50): Promise<any[]> {
    return this.prisma.settingsHistory.findMany({
      where: { settingKey: key },
      orderBy: { changedAt: 'desc' },
      take: limit,
    });
  }

  public async deleteSetting(key: string, deletedBy: string, reason?: string): Promise<void> {
    // Record deletion in history
    const setting = await this.prisma.systemSettings.findUnique({
      where: { key },
    });

    if (setting) {
      await this.prisma.settingsHistory.create({
        data: {
          settingKey: key,
          oldValue: setting.value,
          newValue: "",
          changedBy: deletedBy,
          changeReason: reason || 'Setting deleted',
        },
      });

      await this.prisma.systemSettings.delete({
        where: { key },
      });
    }
  }

  // Helper methods for settings
  private inferDataType(value: any): 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON' {
    if (typeof value === 'number') return 'NUMBER';
    if (typeof value === 'boolean') return 'BOOLEAN';
    if (typeof value === 'object') return 'JSON';
    return 'STRING';
  }

  private formatDisplayName(key: string): string {
    return key
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  // Convenience methods for common settings
  public async getDefaultPricePerKWh(): Promise<number> {
    const price = await this.getSetting('default_price_per_kwh');
    return price || 0.15; // Default fallback
  }

  public async setDefaultPricePerKWh(price: number, changedBy: string): Promise<void> {
    await this.setSetting('default_price_per_kwh', price, changedBy, 'Updated default pricing');
  }

  public async getSystemCurrency(): Promise<string> {
    const currency = await this.getSetting('system_currency');
    return currency || 'NGN';
  }

  public async getTaxRate(): Promise<number> {
    const rate = await this.getSetting('default_tax_rate');
    return rate || 0.0;
  }

  public async getMaxSessionDuration(): Promise<number> {
    const duration = await this.getSetting('max_session_duration_hours');
    return duration || 24; // 24 hours default
  }

  public async initializeDefaultSettings(): Promise<void> {
    const defaultSettings = [
      {
        key: 'default_price_per_kwh',
        value: 500,
        dataType: 'NUMBER' as const,
        category: 'PRICING' as const,
        displayName: 'Default Price per kWh',
        description: 'Default charging rate when no specific pricing tier applies',
        unit: 'NGN',
        minValue: 0.01,
        maxValue: 10.0,
        isPublic: true,
        isRequired: true,
      },
      {
        key: 'system_currency',
        value: 'USD',
        dataType: 'STRING' as const,
        category: 'PRICING' as const,
        displayName: 'System Currency',
        description: 'Default currency for all transactions',
        allowedValues: ['NGN','USD', 'EUR', 'GBP', 'CAD', 'AUD'],
        isPublic: true,
        isRequired: true,
      },
      {
        key: 'default_tax_rate',
        value: 0.08,
        dataType: 'NUMBER' as const,
        category: 'PRICING' as const,
        displayName: 'Default Tax Rate',
        description: 'Default tax rate applied to transactions',
        unit: '%',
        minValue: 0.0,
        maxValue: 1.0,
        isPublic: true,
      },
      {
        key: 'max_session_duration_hours',
        value: 24,
        dataType: 'NUMBER' as const,
        category: 'GENERAL' as const,
        displayName: 'Maximum Session Duration',
        description: 'Maximum allowed charging session duration',
        unit: 'hours',
        minValue: 1,
        maxValue: 168, // 1 week
        isPublic: true,
      },
      {
        key: 'heartbeat_interval_seconds',
        value: 300,
        dataType: 'NUMBER' as const,
        category: 'OCPP' as const,
        displayName: 'Heartbeat Interval',
        description: 'OCPP heartbeat interval in seconds',
        unit: 'seconds',
        minValue: 30,
        maxValue: 3600,
        requiresRestart: true,
      },
      {
        key: 'enable_email_notifications',
        value: true,
        dataType: 'BOOLEAN' as const,
        category: 'NOTIFICATION' as const,
        displayName: 'Enable Email Notifications',
        description: 'Send email notifications for important events',
        isPublic: true,
      },
      {
        key: 'smtp_settings',
        value: {
          host: '',
          port: 587,
          secure: false,
          username: '',
          password: ''
        },
        dataType: 'JSON' as const,
        category: 'NOTIFICATION' as const,
        displayName: 'SMTP Settings',
        description: 'Email server configuration',
        isEditable: true,
      },
      {
        key: 'payment_processor_settings',
        value: {
          stripe: {
            enabled: false,
            publicKey: '',
            secretKey: ''
          },
          paypal: {
            enabled: false,
            clientId: '',
            clientSecret: ''
          }
        },
        dataType: 'JSON' as const,
        category: 'PAYMENT' as const,
        displayName: 'Payment Processor Settings',
        description: 'Configuration for payment processors',
      },
    ];

    for (const setting of defaultSettings) {
      const exists = await this.prisma.systemSettings.findUnique({
        where: { key: setting.key },
      });

      if (!exists) {
        await this.createSetting({
          ...setting,
          createdBy: 'system',
        });
      }
    }
  }

  // Fleet Management
  public async createFleet(data: {
    name: string;
    organizationName?: string;
    registrationNumber?: string;
    taxId?: string;
    contactEmail: string;
    contactPhone?: string;
    website?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
    fleetType?: 'COMMERCIAL' | 'GOVERNMENT' | 'LOGISTICS' | 'TAXI_RIDESHARE' | 'RENTAL' | 'PERSONAL' | 'UTILITY' | 'EMERGENCY' | 'PUBLIC_TRANSPORT' | 'OTHER';
    billingEmail?: string;
    accountManager?: string;
    creditLimit?: number;
    paymentTerms?: string;
    logoImage?: string
  }): Promise<Fleet> {
    return this.prisma.fleet.create({
      data,
    });
  }

  public async getAllFleets(): Promise<Fleet[]> {
    return this.prisma.fleet.findMany({
      where: { isActive: true },
      include: {
        vehicles: {
          where: { isActive: true },
        },
        fleetManagers: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                firstname: true,
                lastname: true,
              },
            },
          },
        },
      },
    });
  }

  public async getFleetById(id: string): Promise<Fleet | null> {
    return this.prisma.fleet.findUnique({
      where: { id },
      include: {
        vehicles: {
          where: { isActive: true },
        },
        fleetManagers: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                firstname: true,
                lastname: true,
              },
            },
          },
        },
      },
    });
  }

  public async updateFleet(id: string, data: Partial<Fleet>): Promise<Fleet> {
    return this.prisma.fleet.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    });
  }

  public async softDeleteFleet(id: string, deletedBy: string, reason?: string): Promise<Fleet> {
    return this.prisma.fleet.update({
      where: { id },
      data: {
        isActive: false,
        status: 'Deleted',
        deletedAt: new Date(),
        deletedBy,
        deleteReason: reason,
        updatedAt: new Date(),
      },
    });
  }

  public async addFleetManager(data: {
    fleetId: string;
    userId: string;
    role?: 'ADMIN' | 'MANAGER' | 'VIEWER' | 'BILLING';
    canManageVehicles?: boolean;
    canViewReports?: boolean;
    canManageBilling?: boolean;
    assignedBy?: string;
  }): Promise<FleetManager> {
    return this.prisma.fleetManager.create({
      data: {
        fleetId: data.fleetId,
        userId: data.userId,
        role: data.role || 'VIEWER',
        canManageVehicles: data.canManageVehicles || false,
        canViewReports: data.canViewReports || true,
        canManageBilling: data.canManageBilling || false,
        assignedBy: data.assignedBy,
      },
    });
  }

  public async removeFleetManager(fleetId: string, userId: string): Promise<FleetManager> {
    return this.prisma.fleetManager.delete({
      where: {
        fleetId_userId: {
          fleetId,
          userId,
        },
      },
    });
  }

  public async getFleetManagers(fleetId: string): Promise<FleetManager[]> {
    return this.prisma.fleetManager.findMany({
      where: { fleetId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            firstname: true,
            lastname: true,
          },
        },
      },
    });
  }

  public async assignVehicleToFleet(vehicleId: string, fleetId: string, transferredBy?: string): Promise<any> {
    // Get current vehicle to preserve audit trail
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });

    if (!vehicle) {
      throw new Error('Vehicle not found');
    }

    return this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        fleetId,
        ownerId: null, // Remove individual owner
        transferredAt: new Date(),
        transferredBy,
        originalFleetId: vehicle.originalFleetId || fleetId, // Set if not already set
        updatedAt: new Date(),
      },
    });
  }

  public async removeVehicleFromFleet(vehicleId: string, newOwnerId?: string, transferredBy?: string): Promise<any> {
    return this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        fleetId: null,
        ownerId: newOwnerId || null,
        transferredAt: new Date(),
        transferredBy,
        updatedAt: new Date(),
      },
    });
  }

  // Fleet Reporting Methods
  public async getFleetTransactions(
    fleetId: string,
    startDate?: Date,
    endDate?: Date,
    limit?: number
  ): Promise<Transaction[]> {
    return this.prisma.transaction.findMany({
      where: {
        vehicle: {
          fleetId: fleetId,
        },
        ...(startDate && { startTimestamp: { gte: startDate } }),
        ...(endDate && { startTimestamp: { lte: endDate } }),
      },
      include: {
        vehicle: true,
        chargePoint: true,
        connector: true,
        idTag: {
          include: {
            user: true,
          },
        },
      },
      orderBy: { startTimestamp: 'desc' },
      ...(limit && { take: limit }),
    });
  }

  public async getFleetEnergyConsumption(
    fleetId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<{
    totalSessions: number;
    totalEnergyKWh: number;
    averageEnergyPerSession: number;
    totalCost: number;
  }> {
    const transactions = await this.prisma.transaction.findMany({
      where: {
        vehicle: {
          fleetId: fleetId,
        },
        stopTimestamp: { not: null }, // Only completed transactions
        ...(startDate && { startTimestamp: { gte: startDate } }),
        ...(endDate && { startTimestamp: { lte: endDate } }),
      },
      select: {
        meterStart: true,
        meterStop: true,
      },
    });

    const totalSessions = transactions.length;
    const totalEnergyKWh = transactions.reduce((sum: number, txn: any) => {
      return sum + ((txn.meterStop || 0) - txn.meterStart);
    }, 0);
    const averageEnergyPerSession = totalSessions > 0 ? totalEnergyKWh / totalSessions : 0;
    
    // Calculate cost (you can adjust the rate as needed)
    const energyRate = 0.15; // $0.15 per kWh - adjust as needed
    const totalCost = totalEnergyKWh * energyRate;

    return {
      totalSessions,
      totalEnergyKWh,
      averageEnergyPerSession,
      totalCost,
    };
  }

  public async getFleetVehicleUtilization(fleetId: string): Promise<any[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        fleetId,
        isActive: true,
      },
      include: {
        transactions: {
          where: {
            stopTimestamp: { not: null },
          },
          select: {
            startTimestamp: true,
            stopTimestamp: true,
            meterStart: true,
            meterStop: true,
          },
        },
      },
    });

    return vehicles.map((vehicle: any) => {
      const totalSessions = vehicle.transactions.length;
      const totalEnergy = vehicle.transactions.reduce((sum: number, txn: any) => {
        return sum + ((txn.meterStop || 0) - txn.meterStart);
      }, 0);

      return {
        vehicleId: vehicle.id,
        licensePlate: vehicle.licensePlate,
        make: vehicle.make,
        model: vehicle.model,
        totalSessions,
        totalEnergy,
        lastUsed: vehicle.transactions.length > 0 
          ? Math.max(...vehicle.transactions.map((t: any) => new Date(t.stopTimestamp!).getTime()))
          : null,
      };
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