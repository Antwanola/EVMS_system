export interface UserStrutcture {
  id?: string;
  username: string;
  firstname: string;
  lastname: string;
  status: boolean;
  email: string;
  password?: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER' | 'THIRD_PARTY';
  isActive?: string;
  apiKey?: string;
  phone?: string;
  idTag?: string;
}