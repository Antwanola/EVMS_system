import { Prisma } from "@prisma/client";

export type UserWithRelations = Prisma.UserGetPayload<{include: { permissions: true, chargePointAccess: true }}>;


const userSecureSelect = Prisma.validator<Prisma.UserSelect>()({
    id: true,
    username: true,
    email: true,
    role: true,
    apiKey: true,
    isActive: true,
    phone: true,
    createdAt: true,
    updatedAt: true,
    idTag: true,
    // Note: password is intentionally NOT listed here
    
    // Include the relations you need
    permissions: true,
    chargePointAccess: true,
});
export type UserSecureWithRelations = Prisma.UserGetPayload<{ select: typeof userSecureSelect }>;