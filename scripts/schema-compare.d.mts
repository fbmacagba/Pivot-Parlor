export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export interface TableDescription {
  columns: Record<string, string>;
  constraints: string[];
  options: string;
}

export interface SchemaDescription {
  tables: Record<string, TableDescription>;
  indexes: Record<string, string>;
  triggers: Record<string, string>;
  views: Record<string, string>;
}

export interface SchemaDifference {
  key: string;
  live: string | null;
  chain: string | null;
}

export interface AllowlistEntry extends SchemaDifference {
  reason: string;
}

export declare function normalizeSql(sql: string | null): string;
export declare function describeSchema(rows: SchemaRow[]): SchemaDescription;
export declare function compareSchemas(live: SchemaDescription, chain: SchemaDescription): SchemaDifference[];
export declare function checkAllowlist(
  differences: SchemaDifference[],
  allowlist: AllowlistEntry[]
): { allowed: SchemaDifference[]; unexpected: SchemaDifference[]; stale: AllowlistEntry[] };
export declare function migrationState(applied: string[], expected: string[]): { pending: string[]; unknown: string[] };
export declare function valueAt(description: SchemaDescription, key: string): string | null;
