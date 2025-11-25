export interface UserStrutcture {
  id?: string;
  username: string;
  firstname: string;
  lastname: string;
  status: string;
  email: string;
  password?: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER' | 'THIRD_PARTY';
  isActive?: boolean;
  apiKey?: string;
  idTag?: string;
  phone?: string;
  idTags?: string;
}