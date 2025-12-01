/*
  Warnings:

  - The `transactionId` column on the `charging_data` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `currentTransactionId` column on the `connectors` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `transactionId` column on the `meter_values` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `transactionId` on the `transactions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_currentTransactionId_fkey";

-- DropForeignKey
ALTER TABLE "meter_values" DROP CONSTRAINT "meter_values_transactionId_fkey";

-- AlterTable
ALTER TABLE "charging_data" DROP COLUMN "transactionId",
ADD COLUMN     "transactionId" INTEGER;

-- AlterTable
ALTER TABLE "connectors" DROP COLUMN "currentTransactionId",
ADD COLUMN     "currentTransactionId" INTEGER;

-- AlterTable
ALTER TABLE "meter_values" DROP COLUMN "transactionId",
ADD COLUMN     "transactionId" INTEGER;

-- AlterTable
ALTER TABLE "transactions" DROP COLUMN "transactionId",
ADD COLUMN     "transactionId" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "connectors_currentTransactionId_key" ON "connectors"("currentTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_transactionId_key" ON "transactions"("transactionId");

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_currentTransactionId_fkey" FOREIGN KEY ("currentTransactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("transactionId") ON DELETE SET NULL ON UPDATE CASCADE;
