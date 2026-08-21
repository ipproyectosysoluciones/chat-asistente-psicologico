/**
 * Structural queryable contract (design §3: provider abstraction). `pg`'s
 * Pool and PoolClient satisfy it structurally, and tests use fakes — the
 * repositories never import `pg` concrete types.
 */
export interface QueryResultRow {
  [column: string]: unknown;
}

export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number | null;
}

export interface DbQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>;
}
