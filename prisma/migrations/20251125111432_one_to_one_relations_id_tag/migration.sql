/*
  Warnings:

  - You are about to drop the `id_tags` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `users` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "charge_point_access" DROP CONSTRAINT "charge_point_access_userId_fkey";

-- DropForeignKey
ALTER TABLE "id_tags" DROP CONSTRAINT "id_tags_userId_fkey";

-- DropForeignKey
ALTER TABLE "permissions" DROP CONSTRAINT "permissions_userId_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_idTagId_fkey";

-- DropTable
DROP TABLE "id_tags";

-- DropTable
DROP TABLE "users";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'VIEWER',
    "phone" TEXT,
    "firstname" TEXT,
    "lastname" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT DEFAULT 'Active',
    "idTagId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdTag" (
    "id" TEXT NOT NULL,
    "idTag" TEXT NOT NULL,
    "parentIdTag" TEXT,
    "status" "id_tag_status" NOT NULL DEFAULT 'ACCEPTED',
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_idTagId_key" ON "User"("idTagId");

-- CreateIndex
CREATE UNIQUE INDEX "IdTag_idTag_key" ON "IdTag"("idTag");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_idTagId_fkey" FOREIGN KEY ("idTagId") REFERENCES "IdTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_idTagId_fkey" FOREIGN KEY ("idTagId") REFERENCES "IdTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_point_access" ADD CONSTRAINT "charge_point_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
