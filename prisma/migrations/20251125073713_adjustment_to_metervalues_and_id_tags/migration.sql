/*
  Warnings:

  - You are about to drop the column `idTag` on the `transactions` table. All the data in the column will be lost.
  - You are about to alter the column `meterStart` on the `transactions` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(65,30)`.
  - You are about to alter the column `meterStop` on the `transactions` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(65,30)`.
  - You are about to drop the column `idTag` on the `users` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "meter_values" DROP CONSTRAINT "meter_values_transactionId_fkey";

-- AlterTable
ALTER TABLE "id_tags" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "transactions" DROP COLUMN "idTag",
ADD COLUMN     "idTagId" TEXT,
ALTER COLUMN "meterStart" SET DATA TYPE DECIMAL(65,30),
ALTER COLUMN "meterStop" SET DATA TYPE DECIMAL(65,30);

-- AlterTable
ALTER TABLE "users" DROP COLUMN "idTag";

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_idTagId_fkey" FOREIGN KEY ("idTagId") REFERENCES "id_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_tags" ADD CONSTRAINT "id_tags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
