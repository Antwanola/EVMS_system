import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

export async function InitialSeed() {
  console.log('🌱 Seeding database...');

  // Create admin user
const adminPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      email: 'antwanola29@gmail.com',
      password: adminPassword,
      role: 'ADMIN',
      isActive: true,
    },
  });

  // Create operator user
  const operatorPassword = await bcrypt.hash('operator123', 12);
  const operator = await prisma.user.upsert({
    where: { username: 'operator' },
    update: {},
    create: {
      username: 'operator',
      email: 'operator@example.com',
      password: operatorPassword,
      role: 'OPERATOR',
      isActive: true,
    },
  });

  // Create sample ID tags
  await prisma.idTag.createMany({
    data: [
      { idTag: 'RFID001', status: 'ACCEPTED' },
      { idTag: 'RFID002', status: 'ACCEPTED' },
      { idTag: 'RFID003', status: 'ACCEPTED' },
      { idTag: 'TEST001', status: 'ACCEPTED' },
      { idTag: 'BLOCKED001', status: 'BLOCKED' },
    ],
    skipDuplicates: true,
  });

  // Create sample charge point
  const chargePoint = await prisma.chargePoint.upsert({
    where: { id: 'CP001' },
    update: {},
    create: {
      id: 'CP001',
      name: 'Main Parking Charge Point',
      vendor: 'ACME Corp',
      model: 'AC-22kW-001',
      serialNumber: 'SN12345678',
      firmwareVersion: '1.0.0',
      location: 'Main Parking Lot',
      description: 'Primary charge point in main parking area',
    },
  });

  // Create connectors for the charge point
  await prisma.connector.createMany({
    data: [
      {
        chargePointId: 'CP001',
        connectorId: 1,
        type: 'TYPE2',
        status: 'AVAILABLE',
        maxPower: 22000,
      },
      {
        chargePointId: 'CP001',
        connectorId: 2,
        type: 'TYPE2',
        status: 'AVAILABLE',
        maxPower: 22000,
      },
    ],
    skipDuplicates: true,
  });

  console.log('✅ Database seeded successfully');
  console.log(`👤 Admin user created - username: antwanola29@gmail.com, password: admin123`);
  console.log('👤 Operator user created - username: operator, password: operator123');
  console.log('🔌 Sample charge point CP001 created with 2 connectors');
  console.log('🏷️ Sample RFID tags created: RFID001, RFID002, RFID003, TEST001');
}

InitialSeed()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
