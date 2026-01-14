// src/types/userWithRelations.ts
// Temporary type definitions until Prisma client is regenerated
export type UserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER' | 'THIRD_PARTY';
export type AccessLevel = 'READ' | 'WRITE' | 'CONTROL' | 'ADMIN';
export type IdTagStatus = 'ACCEPTED' | 'BLOCKED' | 'EXPIRED' | 'INVALID' | 'CONCURRENT_TX';
// Instead of: export enum idTagStatusEnum {accepted: 'ACCEPTED'}
export enum IdTagStatusEnum {
  ACCEPTED = 'ACCEPTED',
  BLOCKED = 'BLOCKED', 
  EXPIRED = 'EXPIRED',
  INVALID = 'INVALID',
  CONCURRENT_TX = 'CONCURRENT_TX'
}



// Base types (temporary until Prisma client is available)
export type User = {
  id: string;
  username: string;
  email: string;
  password: string;
  role: UserRole;
  phone: string | null;
  firstname: string | null;
  lastname: string | null;
  isActive: boolean;
  status: string | null;
  apiKey: string | null;
  idTagId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
};

export type IdTag = {
  id: string;
  idTag: string;
  parentIdTag: string | null;
  status: IdTagStatus;
  isActive: boolean;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  expiryDate: Date | null;
  lastUsed: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Permission = {
  id: string;
  userId: string;
  resource: string;
  action: string;
};

export type ChargePointAccess = {
  id: string;
  userId: string;
  chargePointId: string;
  accessLevel: AccessLevel;
};

// Full user with relations
export type UserWithRelations = User & {
  idTag?: IdTag | null; // one-to-one
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
  role: UserRole;
  apiKey?: string | null;
  isActive: boolean;
  status: string | null;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
  idTag?: IdTag | null;
  permissions: Permission[];
  chargePointAccess: ChargePointAccess[];
};
