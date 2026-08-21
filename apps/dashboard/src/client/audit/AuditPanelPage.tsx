"use client";

import { useEffect, useState, type JSX } from "react";

import {
  auditErrorMessage,
  fetchAuditLog,
  type AuditEntry,
  type AuditQuery,
} from "./api";

/**
 * Audit panel (Phase 5.8 frontend, REQ-DASH-8): supervisors filter the audit
 * trail (resourceType/resourceId/actorId/from/to) and inspect the resulting
 * entries in a table. The token lives in sessionStorage ONLY — never logged
 * (AGENTS.md, clinical data). No audit meta/Pii is ever `console.log`-ged.
 */

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: AuditEntry[] };

export interface AuditPanelPageProps {
  token: string;
}

type FilterField = "resourceType" | "resourceId" | "actorId" | "from" | "to";

const FILTER_FIELDS: readonly FilterField[] = [
  "resourceType",
  "resourceId",
  "actorId",
  "from",
  "to",
];

type FilterState = Record<FilterField, string>;

export function AuditPanelPage({ token }: AuditPanelPageProps): JSX.Element {
  const [filters, setFilters] = useState<FilterState>({
    resourceType: "",
    resourceId: "",
    actorId: "",
    from: "",
    to: "",
  });
  const [state, setState] = useState<PageState>({ status: "loading" });

  function buildQuery(): AuditQuery {
    const query: AuditQuery = {};
    if (filters.resourceType.trim() !== "") {
      query.resourceType = filters.resourceType.trim();
    }
    if (filters.resourceId.trim() !== "") {
      query.resourceId = filters.resourceId.trim();
    }
    if (filters.actorId.trim() !== "") {
      query.actorId = filters.actorId.trim();
    }
    if (filters.from.trim() !== "") {
      query.from = filters.from.trim();
    }
    if (filters.to.trim() !== "") {
      query.to = filters.to.trim();
    }
    return query;
  }

  function load(query: AuditQuery = {}): void {
    setState({ status: "loading" });
    void fetchAuditLog(token, query)
      .then((result) => {
        setState({ status: "ready", entries: result.entries });
      })
      .catch((caught: unknown) => {
        setState({ status: "error", message: auditErrorMessage(caught) });
      });
  }

  useEffect(() => {
    load();
    // Initial load uses no filters; token change triggers a refetch.
  }, [token]);

  function handleFilterChange(field: FilterField, value: string): void {
    setFilters((previous) => ({ ...previous, [field]: value }));
  }

  function handleSearch(): void {
    load(buildQuery());
  }

  if (state.status === "loading") {
    return (
      <section className="audit-panel" aria-label="Panel de auditoría">
        <h2>Auditoría</h2>
        <p className="audit-panel__status" aria-live="polite">
          Cargando registros de auditoría…
        </p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="audit-panel" aria-label="Panel de auditoría">
        <h2>Auditoría</h2>
        <div className="audit-panel__error" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => load(buildQuery())}>
            Reintentar
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="audit-panel" aria-label="Panel de auditoría">
      <h2>Auditoría</h2>

      <form
        className="audit-panel__filters"
        onSubmit={(event) => {
          event.preventDefault();
          handleSearch();
        }}
      >
        {FILTER_FIELDS.map((field) => (
          <label key={field} className="audit-panel__field">
            <span>{field}</span>
            <input
              type="text"
              value={filters[field]}
              onChange={(event) =>
                handleFilterChange(field, event.target.value)
              }
              aria-label={field}
            />
          </label>
        ))}
        <button type="submit">Buscar</button>
      </form>

      {state.entries.length === 0 ? (
        <p className="audit-panel__empty">Sin registros para este filtro.</p>
      ) : (
        <table className="audit-panel__table">
          <thead>
            <tr>
              <th scope="col">Acción</th>
              <th scope="col">Actor</th>
              <th scope="col">Recurso</th>
              <th scope="col">Motivo</th>
              <th scope="col">Fecha</th>
            </tr>
          </thead>
          <tbody>
            {state.entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.action}</td>
                <td>
                  {entry.actorType}
                  {entry.actorId !== undefined ? ` (${entry.actorId})` : ""}
                </td>
                <td>
                  {entry.resourceType}
                  {entry.resourceId !== undefined
                    ? ` (${entry.resourceId})`
                    : ""}
                </td>
                <td>{entry.reason ?? "—"}</td>
                <td>{entry.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
