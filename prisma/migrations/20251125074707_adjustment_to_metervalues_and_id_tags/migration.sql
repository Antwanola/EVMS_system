/*
  Warnings:

  - You are about to alter the column `meterStart` on the `transactions` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `DoublePrecision`.
  - You are about to alter the column `meterStop` on the `transactions` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `DoublePrecision`.

*/
-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "meterStart" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "meterStop" SET DATA TYPE DOUBLE PRECISION;
