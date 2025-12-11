-- DropForeignKey
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_currentTransactionId_fkey";

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_currentTransactionId_fkey" FOREIGN KEY ("currentTransactionId") REFERENCES "transactions"("transactionId") ON DELETE SET NULL ON UPDATE CASCADE;
