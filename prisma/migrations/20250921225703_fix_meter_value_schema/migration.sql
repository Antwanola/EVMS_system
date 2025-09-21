-- AlterEnum
ALTER TYPE "connector_type" ADD VALUE 'GBT';

-- DropForeignKey
ALTER TABLE "meter_values" DROP CONSTRAINT "meter_values_transactionId_fkey";

-- AlterTable
ALTER TABLE "connectors" ALTER COLUMN "type" SET DEFAULT 'GBT';

-- AlterTable
ALTER TABLE "meter_values" ALTER COLUMN "connectorId" DROP NOT NULL,
ALTER COLUMN "chargePointId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
