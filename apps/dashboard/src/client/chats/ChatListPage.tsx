import { useState, type JSX } from "react";

import { useChats } from "./hooks";

/**
 * Paginated chat list (task 5.2 frontend, REQ-DASH-2/9): anonymized
 * identifiers only (never phone numbers, REQ-DASH-9), an alert badge per chat
 * so supervisors triage red/orange first, and loading / error-with-retry /
 * empty states. Opening a chat hands the session id to the parent.
 */

export interface ChatListPageProps {
  token: string;
  onOpenChat(sessionId: string): void;
}

const PAGE_SIZE = 20;

function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 16)}…` : key;
}

export function ChatListPage({ token, onOpenChat }: ChatListPageProps): JSX.Element {
  const [offset, setOffset] = useState(0);
  const { state, reload } = useChats(token, { limit: PAGE_SIZE, offset });

  return (
    <section className="chat-list" aria-label="Conversaciones">
      <h2>Conversaciones</h2>

      {state.status === "loading" && (
        <p className="chat-list__status" aria-live="polite">
          Cargando conversaciones…
        </p>
      )}

      {state.status === "error" && (
        <div className="chat-list__error" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={reload}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === "ready" && state.data.items.length === 0 && (
        <p className="chat-list__empty">No hay conversaciones.</p>
      )}

      {state.status === "ready" && state.data.items.length > 0 && (
        <>
          <ol className="chat-list__items">
            {state.data.items.map((chat) => (
              <li key={chat.sessionId}>
                <button
                  type="button"
                  className="chat-list__chat"
                  onClick={() => onOpenChat(chat.sessionId)}
                  title={`Conversación ${chat.sessionId}`}
                >
                  <span className="chat-list__key">{shortKey(chat.contactKeyAnon)}</span>
                  {chat.openAlertLevel !== undefined && (
                    <span className={`alert-badge alert-badge--${chat.openAlertLevel}`}>
                      {chat.openAlertLevel}
                    </span>
                  )}
                  <span className="chat-list__meta">
                    {chat.jurisdiction ?? "sin jurisdicción"} · {chat.persistenceClass} ·{" "}
                    {chat.messageCount} mensajes
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <nav className="chat-list__pager" aria-label="Paginación">
            <button
              type="button"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
            >
              Anterior
            </button>
            <span className="chat-list__range">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, state.data.total)} de {state.data.total}
            </span>
            <button
              type="button"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= state.data.total}
            >
              Siguiente
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
