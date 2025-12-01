-- DropForeignKey
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_currentTransactionId_fkey";

-- DropForeignKey
ALTER TABLE "meter_values" DROP CONSTRAINT "meter_values_transactionId_fkey";

-- AlterTable
ALTER TABLE "charging_data" ALTER COLUMN "transactionId" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "connectors" ALTER COLUMN "currentTransactionId" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "meter_values" ALTER COLUMN "transactionId" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "transactionId" SET DATA TYPE TEXT;

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_currentTransactionId_fkey" FOREIGN KEY ("currentTransactionId") REFERENCES "transactions"("transactionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("transactionId") ON DELETE SET NULL ON UPDATE CASCADE;
