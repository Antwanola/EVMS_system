/*
  Warnings:

  - Made the column `connectorId` on table `meter_values` required. This step will fail if there are existing NULL values in that column.
  - Made the column `chargePointId` on table `meter_values` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "meter_values" DROP CONSTRAINT "meter_values_transactionId_fkey";

-- AlterTable
ALTER TABLE "meter_values" ALTER COLUMN "connectorId" SET NOT NULL,
ALTER COLUMN "chargePointId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("transactionId") ON DELETE SET NULL ON UPDATE CASCADE;
