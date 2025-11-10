/*
  Warnings:

  - A unique constraint covering the columns `[currentTransactionId]` on the table `connectors` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "currentTransactionId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "connectors_currentTransactionId_key" ON "connectors"("currentTransactionId");

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_currentTransactionId_fkey" FOREIGN KEY ("currentTransactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
