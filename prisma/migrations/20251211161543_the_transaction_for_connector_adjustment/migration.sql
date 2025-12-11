-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_chargePointId_connectorId_fkey";

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_chargePointId_connectorId_fkey" FOREIGN KEY ("chargePointId", "connectorId") REFERENCES "connectors"("chargePointId", "connectorId") ON DELETE CASCADE ON UPDATE CASCADE;
