/*
  Warnings:

  - You are about to drop the column `color` on the `vehicles` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `vehicles` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[vin]` on the table `vehicles` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `batteryCapacityKWh` to the `vehicles` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `vehicles` table without a default value. This is not possible if the table is not empty.
  - Added the required column `vehicleType` to the `vehicles` table without a default value. This is not possible if the table is not empty.
  - Made the column `make` on table `vehicles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `model` on table `vehicles` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "vehicle_type" AS ENUM ('SEDAN', 'SUV', 'HATCHBACK', 'COUPE', 'CONVERTIBLE', 'TRUCK', 'VAN', 'MOTORCYCLE', 'BUS', 'OTHER');

-- CreateEnum
CREATE TYPE "charging_standard" AS ENUM ('CCS1', 'CCS2', 'CHADEMO', 'TYPE1_AC', 'TYPE2_AC', 'TESLA_SUPERCHARGER', 'GBT_AC', 'GBT_DC');

-- CreateEnum
CREATE TYPE "fleet_type" AS ENUM ('COMMERCIAL', 'GOVERNMENT', 'LOGISTICS', 'TAXI_RIDESHARE', 'RENTAL', 'PERSONAL', 'UTILITY', 'EMERGENCY', 'PUBLIC_TRANSPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "fleet_manager_role" AS ENUM ('ADMIN', 'MANAGER', 'VIEWER', 'BILLING');

-- DropForeignKey
ALTER TABLE "vehicles" DROP CONSTRAINT "vehicles_userId_fkey";

-- DropIndex
DROP INDEX "vehicles_licensePlate_key";

-- AlterTable
ALTER TABLE "IdTag" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastUsed" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "fleetDisplayName" TEXT,
ADD COLUMN     "originalFleetId" TEXT,
ADD COLUMN     "originalUserId" TEXT,
ADD COLUMN     "originalVehicleId" TEXT,
ADD COLUMN     "userDisplayName" TEXT,
ADD COLUMN     "vehicleDisplayName" TEXT,
ADD COLUMN     "vehicleId" TEXT;

-- AlterTable
ALTER TABLE "vehicles" DROP COLUMN "color",
DROP COLUMN "userId",
ADD COLUMN     "batteryCapacityKWh" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "chargingStandards" "charging_standard"[],
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "fleetId" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxACPowerKW" DOUBLE PRECISION,
ADD COLUMN     "maxDCPowerKW" DOUBLE PRECISION,
ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "originalFleetId" TEXT,
ADD COLUMN     "originalOwnerId" TEXT,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'Active',
ADD COLUMN     "transferredAt" TIMESTAMP(3),
ADD COLUMN     "transferredBy" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "vehicleType" "vehicle_type" NOT NULL,
ADD COLUMN     "vin" TEXT,
ADD COLUMN     "year" INTEGER,
ALTER COLUMN "licensePlate" DROP NOT NULL,
ALTER COLUMN "make" SET NOT NULL,
ALTER COLUMN "model" SET NOT NULL;

-- CreateTable
CREATE TABLE "fleets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationName" TEXT,
    "registrationNumber" TEXT,
    "taxId" TEXT,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "website" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postalCode" TEXT,
    "fleetSize" INTEGER NOT NULL DEFAULT 0,
    "fleetType" "fleet_type" NOT NULL DEFAULT 'COMMERCIAL',
    "billingEmail" TEXT,
    "accountManager" TEXT,
    "creditLimit" DOUBLE PRECISION,
    "paymentTerms" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "deleteReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_managers" (
    "id" TEXT NOT NULL,
    "fleetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "fleet_manager_role" NOT NULL DEFAULT 'VIEWER',
    "canManageVehicles" BOOLEAN NOT NULL DEFAULT false,
    "canViewReports" BOOLEAN NOT NULL DEFAULT true,
    "canManageBilling" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,

    CONSTRAINT "fleet_managers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fleets_registrationNumber_key" ON "fleets"("registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "fleets_taxId_key" ON "fleets"("taxId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_managers_fleetId_userId_key" ON "fleet_managers"("fleetId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vin_key" ON "vehicles"("vin");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_managers" ADD CONSTRAINT "fleet_managers_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_managers" ADD CONSTRAINT "fleet_managers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
