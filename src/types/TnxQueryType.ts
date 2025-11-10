// Define query parameters interface
export interface TransactionQueryParams {
  page?: string;
  limit?: string;
  search?: string;
  sortBy?: string;
  order?: 'asc' | 'desc';
}