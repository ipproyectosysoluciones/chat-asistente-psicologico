import { useState, type FormEvent, type JSX } from "react";

import { errorMessage, login, type AuthUser } from "./api";

/**
 * Supervisor login form (task 5.1 frontend): accessible labels, loading state
 * during submit, client-side empty validation, and RFC 7807 detail surfaced
 * from the server on failure. Calls onSuccess(user, token) when the JWT is stored.
 */

export interface LoginPageProps {
  onSuccess(user: AuthUser, token: string): void;
}

export function LoginPage({ onSuccess }: LoginPageProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (email.trim().length === 0 || password.length === 0) {
      setError("El correo electrónico y la contraseña son obligatorios.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      onSuccess(result.user, result.token);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <h1>Panel de Supervisión</h1>
      <p className="login-page__notice">
        Acceso restringido al equipo de asistencia psicológica.
      </p>
      <form onSubmit={handleSubmit} noValidate>
        <div className="login-page__field">
          <label htmlFor="login-email">Correo electrónico</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            required
          />
        </div>
        <div className="login-page__field">
          <label htmlFor="login-password">Contraseña</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            required
          />
        </div>
        {error !== null && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Ingresando…" : "Ingresar"}
        </button>
      </form>
    </main>
  );
}
