-- Drop foreign key before altering columns
ALTER TABLE "meter_values" DROP CONSTRAINT IF EXISTS "meter_values_transactionId_fkey";

-- Now safely set the default using the new enum value
ALTER TABLE "connectors"
ALTER COLUMN "type" SET DEFAULT 'GBT';

-- Make connectorId and chargePointId optional
ALTER TABLE "meter_values"
ALTER COLUMN "connectorId" DROP NOT NULL,
ALTER COLUMN "chargePointId" DROP NOT NULL;

-- Re-add the foreign key
ALTER TABLE "meter_values"
ADD CONSTRAINT "meter_values_transactionId_fkey"
FOREIGN KEY ("transactionId")
REFERENCES "transactions"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
