"use client";

import { useEffect, useState, type JSX } from "react";

import {
  deleteVectorChunk,
  fetchVectorSearch,
  type Chunk,
  vectorsErrorMessage,
} from "./api";

/**
 * Vector search page (task 5.5 frontend, REQ-DASH-RAG-7): debounced query →
 * grounding-trace `<table>` (score, category, source, legal framework, content
 * snippet) with a per-row "Eliminar" that optimistically removes the chunk and
 * POSTs the DELETE with the Bearer token. The token lives in sessionStorage
 * ONLY — never logged or written to localStorage (AGENTS.md, clinical data).
 * No message content / raw chunk is ever `console.log`-ged.
 */

const DEBOUNCE_MS = 250;
const SNIPPET_LENGTH = 80;

type PageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; chunks: Chunk[]; query: string };

export interface VectorSearchPageProps {
  token: string;
}

function truncate(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}…`;
}

export function VectorSearchPage({ token }: VectorSearchPageProps): JSX.Element {
  const [term, setTerm] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [state, setState] = useState<PageState>({ status: "idle" });

  useEffect(() => {
    const id = setTimeout(() => setSearchTerm(term), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [term]);

  useEffect(() => {
    if (searchTerm.length === 0) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    void fetchVectorSearch(token, { q: searchTerm })
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", chunks: data.chunks, query: data.query });
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: vectorsErrorMessage(caught) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, searchTerm]);

  async function handleRemove(chunk: Chunk): Promise<void> {
    // Optimistic remove first — the row disappears instantly, then we reconcile
    // with the DELETE. A failure reverts the optimistic change and surfaces the
    // RFC 7807 detail (REQ-DASH-9).
    setState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            chunks: current.chunks.filter((c) => c.chunkId !== chunk.chunkId),
            query: current.query,
          }
        : current
    );
    try {
      await deleteVectorChunk(token, chunk.docId, chunk.chunkIndex);
    } catch (caught: unknown) {
      setState((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              chunks: [...current.chunks, chunk],
              query: current.query,
            }
          : current
      );
      setState({ status: "error", message: vectorsErrorMessage(caught) });
    }
  }

  return (
    <section className="vector-search" aria-label="Búsqueda de vectores">
      <h2>Búsqueda de vectores</h2>
      <label htmlFor="vector-query">Término de búsqueda</label>
      <input
        id="vector-query"
        type="search"
        placeholder="Buscar vectores por contenido…"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        aria-invalid={state.status === "error"}
      />

      {state.status === "loading" && (
        <p className="vector-search__status" aria-live="polite">
          Buscando…
        </p>
      )}
      {state.status === "error" && (
        <p className="vector-search__error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "idle" && (
        <p className="vector-search__hint">
          Ingrese un término para buscar chunks vectorizados.
        </p>
      )}
      {state.status === "ready" && state.chunks.length === 0 && (
        <p className="vector-search__empty">Sin resultados.</p>
      )}
      {state.status === "ready" && state.chunks.length > 0 && (
        <table className="vector-search__table">
          <thead>
            <tr>
              <th scope="col">Score</th>
              <th scope="col">Categoría</th>
              <th scope="col">Fuente</th>
              <th scope="col">Marco legal</th>
              <th scope="col">Fragmento</th>
              <th scope="col" aria-label="Acciones" />
            </tr>
          </thead>
          <tbody>
            {state.chunks.map((chunk) => (
              <tr key={chunk.chunkId}>
                <td>{chunk.score.toFixed(2)}</td>
                <td>{chunk.category}</td>
                <td>{chunk.source}</td>
                <td>{chunk.legalFramework}</td>
                <td>{truncate(chunk.content, SNIPPET_LENGTH)}</td>
                <td>
                  <button
                    type="button"
                    title={`Eliminar fragmento ${chunk.chunkId}`}
                    onClick={() => void handleRemove(chunk)}
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
