-- AlterTable
ALTER TABLE "User" ADD COLUMN     "image" TEXT;

-- AlterTable
ALTER TABLE "fleets" ADD COLUMN     "fleetLogo" TEXT,
ADD COLUMN     "logoImage" TEXT;

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "car_image" TEXT;
