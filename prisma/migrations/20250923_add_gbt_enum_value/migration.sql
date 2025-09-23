-- Add the new enum value separately so it can commit first
ALTER TYPE "connector_type" ADD VALUE IF NOT EXISTS 'GBT';
