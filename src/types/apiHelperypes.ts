export interface UserStrutcture {
  id?: string;
  username: string;
  email: string;
  password?: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER' | 'THIRD_PARTY';
  isActive?: boolean;
  apiKey?: string;
  phone?: string;
  idTag?: string;
}