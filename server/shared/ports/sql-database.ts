export type SqlValue = string | number | boolean | null;

export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown> & {
    changes: number;
    last_row_id: number;
  };
}

export interface SqlPreparedStatement {
  bind(...values: SqlValue[]): SqlPreparedStatement;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlPreparedStatement;
  batch<T = unknown>(statements: SqlPreparedStatement[]): Promise<SqlResult<T>[]>;
}
