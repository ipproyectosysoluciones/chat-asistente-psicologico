"use client";

import { useEffect, useState, type JSX } from "react";

import { io } from "../alerts/socket";
import {
  fetchRotationStatus,
  keysErrorMessage,
  rotateKeys,
  type KeyRow,
  type RotationStatus,
} from "./api";

/**
 * Key-rotation monitor (task 5.6 frontend, REQ-KEY-3/REQ-DASH-1): renders the
 * active-key countdown, the forced-12h banner with the past-due keys, a dry-run
 * toggle and a "Rotar ahora" button that triggers an admin-only rotation
 * (confirm-gated). The token lives in sessionStorage ONLY — never logged
 * (AGENTS.md, clinical data). A live `rotation:completed` socket event
 * (reusing the shared socket.io `io` from alerts/socket) triggers a refresh so
 * supervisors see the outcome < 1s after it lands. No key material is ever
 * rendered or logged.
 */

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: RotationStatus };

type Notice =
  | { type: "error"; message: string }
  | { type: "success"; message: string };

export interface KeyRotationPageProps {
  token: string;
}

export function KeyRotationPage({ token }: KeyRotationPageProps): JSX.Element {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [dryRun, setDryRun] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  function load(): void {
    setState({ status: "loading" });
    setNotice(undefined);
    void fetchRotationStatus(token)
      .then((data) => {
        setState({ status: "ready", data });
      })
      .catch((caught: unknown) => {
        setState({ status: "error", message: keysErrorMessage(caught) });
      });
  }

  useEffect(() => {
    load();
  }, [token]);

  useEffect(() => {
    const socket = io(undefined, { auth: { token } });
    socket.on("rotation:completed", () => {
      load();
    });
    return () => {
      socket.disconnect();
    };
  }, [token]);

  async function handleRotate(): Promise<void> {
    if (state.status !== "ready") {
      return;
    }
    const dueNow =
      state.data.forcedDue.length > 0 || state.data.daysUntilRotation === 0;
    if (
      !confirm(
        "¿Seguro que desea rotar las claves ahora? Esta acción es irreversible."
      )
    ) {
      return;
    }
    setNotice(undefined);
    try {
      await rotateKeys(token, { forced: dueNow, dryRun });
      setNotice({
        type: "success",
        message: dryRun
          ? "Simulación de rotación completada."
          : "Rotación de claves completada.",
      });
    } catch (caught: unknown) {
      setNotice({ type: "error", message: keysErrorMessage(caught) });
    }
  }

  if (state.status === "loading") {
    return (
      <section className="key-rotation" aria-label="Rotación de claves">
        <h2>Rotación de claves</h2>
        <p className="key-rotation__status" aria-live="polite">
          Cargando estado de rotación…
        </p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="key-rotation" aria-label="Rotación de claves">
        <h2>Rotación de claves</h2>
        <div className="key-rotation__error" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => load()}>
            Reintentar
          </button>
        </div>
      </section>
    );
  }

  const data = state.data;

  return (
    <section className="key-rotation" aria-label="Rotación de claves">
      <header className="key-rotation__header">
        <h2>Rotación de claves</h2>
        <p className="key-rotation__countdown">
          Próxima rotación en: {data.daysUntilRotation} días
        </p>
      </header>

      {data.forcedDue.length > 0 && (
        <div className="key-rotation__forced" role="status">
          <p>
            <strong>Forzado 12h</strong>: claves próximas a caducidad forzosa.
          </p>
          <ul className="key-rotation__forced-list">
            {data.forcedDue.map((row: KeyRow) => (
              <li key={row.keyVersion}>
                v{row.keyVersion} · {row.status} · {row.createdAt}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="key-rotation__pending">
        Filas pendientes de reencriptación: {data.pendingRows}
      </p>

      <fieldset className="key-rotation__options">
        <label>
          <input
            id="key-rotation-dry-run"
            type="checkbox"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
          />
          Simular (dry-run)
        </label>
      </fieldset>

      <button type="button" onClick={() => void handleRotate()}>
        Rotar ahora
      </button>

      {notice !== undefined && (
        <p
          className={
            notice.type === "error"
              ? "key-rotation__notice key-rotation__notice--error"
              : "key-rotation__notice"
          }
          role={notice.type === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}
    </section>
  );
}
