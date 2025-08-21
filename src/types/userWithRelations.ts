import { Prisma } from "@prisma/client";

export type UserWithRelations = Prisma.UserGetPayload<{include: { permissions: true, chargePointAccess: true }}>;