-- CreateEnum
CREATE TYPE "connector_type" AS ENUM ('CCS', 'CHAdeMO', 'TYPE2', 'TYPE1', 'TESLA');

-- CreateEnum
CREATE TYPE "connector_status" AS ENUM ('AVAILABLE', 'PREPARING', 'CHARGING', 'SUSPENDED_EVSE', 'SUSPENDED_EV', 'FINISHING', 'RESERVED', 'UNAVAILABLE', 'FAULTED');

-- CreateEnum
CREATE TYPE "stop_reason" AS ENUM ('EMERGENCY_STOP', 'EV_DISCONNECTED', 'HARD_RESET', 'LOCAL', 'OTHER', 'POWER_LOSS', 'REBOOT', 'REMOTE', 'SOFT_RESET', 'UNLOCK_COMMAND', 'DE_AUTHORIZED', 'ENERGY_LIMIT_REACHED', 'GROUND_FAULT', 'IMMEDIATE_RESET', 'LOCAL_OUT_OF_CREDIT', 'MASTER_PASS', 'OVERCURRENT_FAULT', 'POWER_QUALITY', 'SOC_LIMIT_REACHED', 'STOPPED_BY_EV', 'TIME_LIMIT_REACHED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "access_level" AS ENUM ('READ', 'WRITE', 'CONTROL', 'ADMIN');

-- CreateEnum
CREATE TYPE "alarm_severity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "id_tag_status" AS ENUM ('ACCEPTED', 'BLOCKED', 'EXPIRED', 'INVALID', 'CONCURRENT_TX');

-- CreateTable
CREATE TABLE "charge_points" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "vendor" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serialNumber" TEXT,
    "firmwareVersion" TEXT,
    "iccid" TEXT,
    "imsi" TEXT,
    "meterType" TEXT,
    "meterSerialNumber" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "lastSeen" TIMESTAMP(3),
    "heartbeatInterval" INTEGER NOT NULL DEFAULT 300,
    "bootNotificationSent" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charge_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connectors" (
    "id" SERIAL NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "connectorId" INTEGER NOT NULL,
    "type" "connector_type" NOT NULL DEFAULT 'TYPE2',
    "status" "connector_status" NOT NULL DEFAULT 'AVAILABLE',
    "errorCode" TEXT,
    "info" TEXT,
    "vendorId" TEXT,
    "vendorErrorCode" TEXT,
    "maxPower" DOUBLE PRECISION,
    "inputVoltage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inputCurrent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outputContactors" BOOLEAN NOT NULL DEFAULT false,
    "outputVoltage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outputEnergy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "chargingEnergy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gunTemperature" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "stateOfCharge" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "chargeTime" INTEGER NOT NULL DEFAULT 0,
    "remainingTime" INTEGER NOT NULL DEFAULT 0,
    "demandCurrent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" SERIAL NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "connectorId" INTEGER NOT NULL,
    "idTag" TEXT NOT NULL,
    "meterStart" DOUBLE PRECISION NOT NULL,
    "meterStop" DOUBLE PRECISION,
    "startTimestamp" TIMESTAMP(3) NOT NULL,
    "stopTimestamp" TIMESTAMP(3),
    "stopReason" "stop_reason",
    "reservationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charging_data" (
    "id" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "connectorId" INTEGER NOT NULL,
    "transactionId" INTEGER,
    "gunType" "connector_type" NOT NULL,
    "status" "connector_status" NOT NULL,
    "inputVoltage" DOUBLE PRECISION NOT NULL,
    "inputCurrent" DOUBLE PRECISION NOT NULL,
    "outputContactors" BOOLEAN NOT NULL,
    "outputVoltage" DOUBLE PRECISION NOT NULL,
    "outputEnergy" DOUBLE PRECISION NOT NULL,
    "chargingEnergy" DOUBLE PRECISION NOT NULL,
    "alarm" TEXT,
    "stopReason" "stop_reason",
    "connected" BOOLEAN NOT NULL,
    "gunTemperature" DOUBLE PRECISION NOT NULL,
    "stateOfCharge" DOUBLE PRECISION NOT NULL,
    "chargeTime" INTEGER NOT NULL,
    "remainingTime" INTEGER NOT NULL,
    "demandCurrent" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charging_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_values" (
    "id" TEXT NOT NULL,
    "transactionId" INTEGER,
    "connectorId" INTEGER NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sampled_values" (
    "id" TEXT NOT NULL,
    "meterValueId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "context" TEXT,
    "format" TEXT,
    "measurand" TEXT,
    "phase" TEXT,
    "location" TEXT,
    "unit" TEXT,

    CONSTRAINT "sampled_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'VIEWER',
    "apiKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_point_access" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "accessLevel" "access_level" NOT NULL DEFAULT 'READ',

    CONSTRAINT "charge_point_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_point_configurations" (
    "id" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "readonly" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "charge_point_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alarms" (
    "id" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "connectorId" INTEGER,
    "alarmType" TEXT NOT NULL,
    "severity" "alarm_severity" NOT NULL,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alarms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_tags" (
    "id" TEXT NOT NULL,
    "idTag" TEXT NOT NULL,
    "parentIdTag" TEXT,
    "status" "id_tag_status" NOT NULL DEFAULT 'ACCEPTED',
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "id_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connectors_chargePointId_connectorId_key" ON "connectors"("chargePointId", "connectorId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_transactionId_key" ON "transactions"("transactionId");

-- CreateIndex
CREATE INDEX "charging_data_chargePointId_timestamp_idx" ON "charging_data"("chargePointId", "timestamp");

-- CreateIndex
CREATE INDEX "charging_data_connectorId_timestamp_idx" ON "charging_data"("connectorId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_apiKey_key" ON "users"("apiKey");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_userId_resource_action_key" ON "permissions"("userId", "resource", "action");

-- CreateIndex
CREATE UNIQUE INDEX "charge_point_access_userId_chargePointId_key" ON "charge_point_access"("userId", "chargePointId");

-- CreateIndex
CREATE UNIQUE INDEX "charge_point_configurations_chargePointId_key_key" ON "charge_point_configurations"("chargePointId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "id_tags_idTag_key" ON "id_tags"("idTag");

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "charge_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "charge_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_chargePointId_connectorId_fkey" FOREIGN KEY ("chargePointId", "connectorId") REFERENCES "connectors"("chargePointId", "connectorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_data" ADD CONSTRAINT "charging_data_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "charge_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charging_data" ADD CONSTRAINT "charging_data_chargePointId_connectorId_fkey" FOREIGN KEY ("chargePointId", "connectorId") REFERENCES "connectors"("chargePointId", "connectorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("transactionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sampled_values" ADD CONSTRAINT "sampled_values_meterValueId_fkey" FOREIGN KEY ("meterValueId") REFERENCES "meter_values"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_point_access" ADD CONSTRAINT "charge_point_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_point_configurations" ADD CONSTRAINT "charge_point_configurations_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "charge_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "charge_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
