import { useEffect, useState, type JSX } from "react";

import { AlertSemaphore } from "./alerts/AlertSemaphore";
import { clearStoredToken, errorMessage, fetchMe, getStoredToken } from "./auth/api";
import type { AuthUser } from "./auth/api";
import { LoginPage } from "./auth/LoginPage";
import { ChatDetailPage } from "./chats/ChatDetailPage";
import { ChatListPage } from "./chats/ChatListPage";

/**
 * Auth gate (task 5.1 frontend): no stored token → LoginPage; stored token →
 * validate against /auth/me → supervisor home; failures clear the token and
 * offer retry/logout. State is a discriminated union (AGENTS.md).
 * The authenticated token is threaded into the chats views (task 5.2).
 */

type AuthState =
  | { status: "unauthenticated" }
  | { status: "checking" }
  | { status: "authenticated"; user: AuthUser; token: string }
  | { status: "auth_error"; message: string };

type HomeView = { name: "list" } | { name: "detail"; sessionId: string };

export function App(): JSX.Element {
  const [state, setState] = useState<AuthState>(() =>
    getStoredToken() === null
      ? { status: "unauthenticated" }
      : { status: "checking" }
  );

  async function bootstrapSession(): Promise<void> {
    const token = getStoredToken();
    if (token === null) {
      setState({ status: "unauthenticated" });
      return;
    }
    setState({ status: "checking" });
    try {
      const user = await fetchMe(token);
      setState({ status: "authenticated", user, token });
    } catch (caught) {
      clearStoredToken();
      setState({ status: "auth_error", message: errorMessage(caught) });
    }
  }

  function handleLogout(): void {
    clearStoredToken();
    setState({ status: "unauthenticated" });
  }

  useEffect(() => {
    void bootstrapSession();
  }, []);

  switch (state.status) {
    case "unauthenticated":
      return (
        <LoginPage
          onSuccess={(user, token) => setState({ status: "authenticated", user, token })}
        />
      );
    case "checking":
      return (
        <main className="session-checking" aria-live="polite">
          <p>Verificando la sesión…</p>
        </main>
      );
    case "auth_error":
      return (
        <main className="session-error">
          <h1>Panel de Supervisión</h1>
          <p role="alert">{state.message}</p>
          <button type="button" onClick={() => void bootstrapSession()}>
            Reintentar
          </button>
          <button type="button" onClick={handleLogout}>
            Cerrar sesión
          </button>
        </main>
      );
    case "authenticated":
      return (
        <SupervisorHome user={state.user} token={state.token} onLogout={handleLogout} />
      );
  }
}

interface SupervisorHomeProps {
  user: AuthUser;
  token: string;
  onLogout(): void;
}

function SupervisorHome({ user, token, onLogout }: SupervisorHomeProps) {
  const [view, setView] = useState<HomeView>({ name: "list" });

  return (
    <div className="supervisor-home">
      <header className="supervisor-home__header">
        <h1>Panel de Supervisión</h1>
        <p className="supervisor-home__session">
          {user.email} · <strong>{user.role}</strong>
        </p>
        <button type="button" onClick={onLogout}>
          Cerrar sesión
        </button>
      </header>
      <AlertSemaphore token={token} />
      {view.name === "list" ? (
        <ChatListPage
          token={token}
          onOpenChat={(sessionId) => setView({ name: "detail", sessionId })}
        />
      ) : (
        <ChatDetailPage
          token={token}
          sessionId={view.sessionId}
          onBack={() => setView({ name: "list" })}
        />
      )}
    </div>
  );
}
