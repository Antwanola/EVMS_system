// src/types/userWithRelations.ts
import type { User, Permission, ChargePointAccess, IdTag } from '@prisma/client';


// Full user with relations
export type UserWithRelations = User & {
  idTag: IdTag | null; // one-to-one
  permissions: Permission[];
  chargePointAccess: ChargePointAccess[];
};


// Secure user select
export type UserSecureWithRelations = {
  id: string;
  username: string;
  firstname: string | null;
  lastname: string | null;
  email: string;
  role: User['role'];
  apiKey?: string | null;            // optional, only if exists in schema
  isActive: boolean;
  status: string | null;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
  idTag: IdTag | null;               // one-to-one
  permissions: Permission[];
  chargePointAccess: ChargePointAccess[];
};
