-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "charging_standard" ADD VALUE 'GBT';
ALTER TYPE "charging_standard" ADD VALUE 'TYPE2';
ALTER TYPE "charging_standard" ADD VALUE 'CCS';
