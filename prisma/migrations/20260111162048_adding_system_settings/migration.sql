-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'PAYPAL', 'STRIPE', 'APPLE_PAY', 'GOOGLE_PAY', 'CASH', 'FLEET_ACCOUNT', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'OVERDUE', 'PAID', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "customer_type" AS ENUM ('USER', 'FLEET');

-- CreateEnum
CREATE TYPE "setting_data_type" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON', 'EMAIL', 'URL', 'PASSWORD');

-- CreateEnum
CREATE TYPE "setting_category" AS ENUM ('GENERAL', 'PRICING', 'PAYMENT', 'NOTIFICATION', 'SECURITY', 'INTEGRATION', 'OCPP', 'MAINTENANCE', 'REPORTING', 'UI');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'NGN',
ADD COLUMN     "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
ADD COLUMN     "energyConsumed" DOUBLE PRECISION,
ADD COLUMN     "invoiceId" TEXT,
ADD COLUMN     "isPaid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentMethod" "payment_method",
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "paymentStatus" "payment_status" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "pricePerKWh" DOUBLE PRECISION,
ADD COLUMN     "pricingTierId" TEXT,
ADD COLUMN     "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
ADD COLUMN     "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
ADD COLUMN     "totalAmount" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "pricing_tiers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pricePerKWh" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "peakHourRate" DOUBLE PRECISION,
    "offPeakRate" DOUBLE PRECISION,
    "peakHoursStart" TEXT,
    "peakHoursEnd" TEXT,
    "minimumKWh" DOUBLE PRECISION,
    "maximumKWh" DOUBLE PRECISION,
    "requiresMembership" BOOLEAN NOT NULL DEFAULT false,
    "membershipType" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_point_pricing" (
    "id" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "pricingTierId" TEXT NOT NULL,
    "customPricePerKWh" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charge_point_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "customerId" TEXT,
    "customerType" "customer_type" NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "billingAddress" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidDate" TIMESTAMP(3),
    "subtotal" DOUBLE PRECISION NOT NULL,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" "payment_status" NOT NULL DEFAULT 'PENDING',
    "paymentMethod" "payment_method",
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentMethod" "payment_method" NOT NULL,
    "paymentReference" TEXT,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "processedAt" TIMESTAMP(3),
    "invoiceId" TEXT,
    "customerId" TEXT,
    "customerType" "customer_type",
    "processorName" TEXT,
    "processorTransactionId" TEXT,
    "failureReason" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "dataType" "setting_data_type" NOT NULL DEFAULT 'STRING',
    "category" "setting_category" NOT NULL DEFAULT 'GENERAL',
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "allowedValues" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "isEditable" BOOLEAN NOT NULL DEFAULT true,
    "requiresRestart" BOOLEAN NOT NULL DEFAULT false,
    "lastModifiedBy" TEXT,
    "lastModifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings_history" (
    "id" TEXT NOT NULL,
    "settingKey" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changeReason" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pricing_tiers_name_key" ON "pricing_tiers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "charge_point_pricing_chargePointId_pricingTierId_key" ON "charge_point_pricing"("chargePointId", "pricingTierId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_pricingTierId_fkey" FOREIGN KEY ("pricingTierId") REFERENCES "pricing_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_point_pricing" ADD CONSTRAINT "charge_point_pricing_chargePointId_fkey" FOREIGN KEY ("chargePointId") REFERENCES "charge_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_point_pricing" ADD CONSTRAINT "charge_point_pricing_pricingTierId_fkey" FOREIGN KEY ("pricingTierId") REFERENCES "pricing_tiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
