import { type JSX } from "react";

import type { ChatDetail, RagTrace } from "./api";
import { useChatDetail } from "./hooks";

/**
 * Dual chat view (task 5.2 frontend, REQ-DASH-2): user/bot messages beside
 * the exact RAG trace that grounded the bot answer — gate verdict and scores
 * (cosine, NLI), role-deviation guardrail terms, retrieved chunks — plus the
 * active alert level. Encrypted messages render as such; the dashboard never
 * carries decryption keys. Loading / error-with-retry states (REQ-DASH-9).
 */

export interface ChatDetailPageProps {
  token: string;
  sessionId: string;
  onBack(): void;
}

const VERDICT_LABEL: Record<RagTrace["gate"]["verdict"], string> = {
  emit: "Emitida",
  retry: "Reintento",
  yellow_flag: "Señal amarilla",
  orange_block: "Respuesta bloqueada",
};

function verdictLabel(verdict: RagTrace["gate"]["verdict"]): string {
  return VERDICT_LABEL[verdict] ?? verdict;
}

function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 16)}…` : key;
}

export function ChatDetailPage({ token, sessionId, onBack }: ChatDetailPageProps): JSX.Element {
  const { state, reload } = useChatDetail(token, sessionId);

  return (
    <section className="chat-detail" aria-label="Conversación">
      <button type="button" className="chat-detail__back" onClick={onBack}>
        ← Volver a conversaciones
      </button>

      {state.status === "loading" && (
        <p className="chat-detail__status" aria-live="polite">
          Cargando conversación…
        </p>
      )}

      {state.status === "error" && (
        <div className="chat-detail__error" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={reload}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === "ready" && <ChatDetailView detail={state.data} />}
    </section>
  );
}

function ChatDetailView({ detail }: { detail: ChatDetail }) {
  return (
    <>
      <header className="chat-detail__header">
        <h2>Conversación {shortKey(detail.session.contactKeyAnon)}</h2>
        <p className="chat-detail__meta">
          {detail.session.jurisdiction ?? "sin jurisdicción"} · {detail.session.persistenceClass} ·{" "}
          {detail.session.aiState}
        </p>
        {detail.alertLevel !== undefined && (
          <p className={`chat-detail__alert alert-badge--${detail.alertLevel}`} role="status">
            Alerta activa: {detail.alertLevel}
          </p>
        )}
      </header>

      <div className="chat-detail__dual">
        <section className="chat-detail__messages" aria-label="Mensajes">
          <h3>Mensajes</h3>
          <ol className="message-list">
            {detail.messages.map((message) => (
              <li key={message.id} className={`message message--${message.sender}`}>
                <p className="message__sender">{message.sender === "user" ? "Usuario" : "Asistente"}</p>
                {message.encrypted && message.text === undefined ? (
                  <p className="message__encrypted">Mensaje cifrado (no visible en el panel)</p>
                ) : (
                  <p className="message__text">{message.text ?? ""}</p>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="chat-detail__rag" aria-label="Contexto RAG">
          <h3>Contexto RAG</h3>
          {detail.ragTraces.length === 0 ? (
            <p className="chat-detail__rag-empty">Sin trazas de contexto para esta conversación.</p>
          ) : (
            <ol className="trace-list">
              {detail.ragTraces.map((trace) => (
                <li key={trace.traceId}>
                  <article className="trace">
                    <p className="trace__verdict">{verdictLabel(trace.gate.verdict)}</p>
                    <p className="trace__meta">
                      coseno {trace.gate.cosine.toFixed(2)} · NLI {trace.gate.nli.verdict}
                      {trace.latencyMs === undefined ? "" : ` · ${trace.latencyMs} ms`}
                    </p>
                    <p className="trace__guardrail">
                      {trace.gate.guardrail.deviationTerms.length === 0 ? (
                        "Sin desvíos de rol"
                      ) : (
                        <>
                          Términos de desvío:{" "}
                          {trace.gate.guardrail.deviationTerms.map((term) => (
                            <span key={term} className="trace__term">
                              {term}
                            </span>
                          ))}
                        </>
                      )}
                    </p>
                    <ol className="trace__chunks">
                      {trace.gate.chunks.map((chunk) => (
                        <li key={chunk.chunkId}>
                          <blockquote className="chunk">{chunk.content}</blockquote>
                          <p className="chunk__meta">
                            {chunk.source} · {chunk.category} · {chunk.language} · score{" "}
                            {chunk.score.toFixed(2)}
                          </p>
                        </li>
                      ))}
                    </ol>
                  </article>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
