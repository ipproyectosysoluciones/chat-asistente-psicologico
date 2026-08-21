import { useEffect, useState, type JSX } from "react";

import {
  acknowledgeAlert,
  alertsErrorMessage,
  fetchAlerts,
  resolveAlert,
  type AlertItem,
} from "./api";
import { connectAlertSocket } from "./socket";

/**
 * Alert semaphore (task 5.4 frontend, REQ-DASH-4/9): live red/orange/yellow
 * alert feed with per-alert details and acknowledge/resolve actions. The
 * initial feed comes from GET /alerts (severity-first); every later change is
 * pushed over Socket.io (`alert:event` / `alert:updated`), so a red alert
 * renders < 1s after raise (REQ-ALERT-2). Loading, error-with-retry and empty
 * states are discriminated-union driven (REQ-DASH-9), and the WebSocket is
 * released on unmount (REQ-DASH-9). Rows render anonymized identifiers only —
 * never phones or raw message content (REQ-DASH-9).
 */

type FeedState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: AlertItem[] };

const LEVEL_LABEL: Record<AlertItem["level"], string> = {
  red: "Roja",
  orange: "Naranja",
  yellow: "Amarilla",
};

const LEVEL_DESCRIPTION: Record<AlertItem["level"], string> = {
  red: "riesgo vital",
  orange: "bloqueo por desviación de rol",
  yellow: "incoherencia",
};

export interface AlertSemaphoreProps {
  token: string;
}

export function AlertSemaphore({ token }: AlertSemaphoreProps): JSX.Element {
  const [state, setState] = useState<FeedState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [liveNotice, setLiveNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setLiveNotice(undefined);
    void fetchAlerts(token)
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", items: data.items });
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: alertsErrorMessage(caught) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  useEffect(() => {
    const socket = connectAlertSocket(token);
    socket.onAlert((alert) => {
      setState((current) => {
        if (current.status === "ready") {
          const rest = current.items.filter((item) => item.id !== alert.id);
          return { status: "ready", items: [alert, ...rest] };
        }
        if (current.status === "error") {
          // The live stream is authoritative even when the initial REST feed
          // failed — a real alert must never wait for a manual retry.
          return { status: "ready", items: [alert] };
        }
        return current;
      });
    });
    socket.onAlertUpdated((alert) => {
      setState((current) => {
        if (current.status !== "ready") {
          return current;
        }
        const present = current.items.some((item) => item.id === alert.id);
        const items = present
          ? current.items.map((item) => (item.id === alert.id ? alert : item))
          : [alert, ...current.items];
        return { status: "ready", items };
      });
    });
    socket.onError(() => {
      setLiveNotice("Se perdió la conexión en vivo. Reintentando…");
    });
    return () => {
      socket.disconnect();
    };
  }, [token]);

  function applyUpdate(alert: AlertItem): void {
    setState((current) => {
      if (current.status !== "ready") {
        return current;
      }
      const present = current.items.some((item) => item.id === alert.id);
      const items = present
        ? current.items.map((item) => (item.id === alert.id ? alert : item))
        : [alert, ...current.items];
      return { status: "ready", items };
    });
  }

  async function handleAcknowledge(alertId: string): Promise<void> {
    try {
      const updated = await acknowledgeAlert(token, alertId);
      applyUpdate(updated);
    } catch (caught) {
      setLiveNotice(alertsErrorMessage(caught));
    }
  }

  async function handleResolve(alertId: string): Promise<void> {
    try {
      const updated = await resolveAlert(token, alertId);
      applyUpdate(updated);
    } catch (caught) {
      setLiveNotice(alertsErrorMessage(caught));
    }
  }

  if (state.status === "loading") {
    return (
      <section
        className="alert-semaphore"
        aria-label="Alertas activas"
        aria-busy="true"
      >
        <h2>Alertas activas</h2>
        <p className="alert-semaphore__status" aria-live="polite">
          Cargando alertas…
        </p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="alert-semaphore" aria-label="Alertas activas">
        <h2>Alertas activas</h2>
        <div className="alert-semaphore__error" role="alert">
          <p>{state.message}</p>
          <button
            type="button"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Reintentar
          </button>
        </div>
      </section>
    );
  }

  const openCount = state.items.filter((item) => item.status === "open").length;

  return (
    <section className="alert-semaphore" aria-label="Alertas activas">
      <header className="alert-semaphore__header">
        <h2>Alertas activas</h2>
        <span className="alert-semaphore__count">
          {openCount} abierta{openCount === 1 ? "" : "s"}
        </span>
      </header>
      {liveNotice !== undefined && (
        <p className="alert-semaphore__notice" role="status">
          {liveNotice}
        </p>
      )}
      {state.items.length === 0 ? (
        <p className="alert-semaphore__empty">Sin alertas.</p>
      ) : (
        <ol className="alert-semaphore__items" aria-live="polite">
          {state.items.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              onAcknowledge={() => void handleAcknowledge(alert.id)}
              onResolve={() => void handleResolve(alert.id)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

interface AlertRowProps {
  alert: AlertItem;
  onAcknowledge(): void;
  onResolve(): void;
}

function AlertRow({
  alert,
  onAcknowledge,
  onResolve,
}: AlertRowProps): JSX.Element {
  return (
    <li
      className="alert-semaphore__item"
      data-alert-level={alert.level}
      data-alert-status={alert.status}
    >
      <span
        className={`alert-badge alert-badge--${alert.level}`}
        title={LEVEL_DESCRIPTION[alert.level]}
      >
        {LEVEL_LABEL[alert.level]}
      </span>
      <span className="alert-semaphore__category">{alert.category}</span>
      <span className="alert-semaphore__session">{alert.sessionId}</span>
      <time className="alert-semaphore__time" dateTime={alert.createdAt}>
        {new Date(alert.createdAt).toLocaleString()}
      </time>
      <span className="alert-semaphore__state">{alert.status}</span>
      {alert.status === "open" && (
        <button
          type="button"
          onClick={onAcknowledge}
          aria-label={`Reconocer alerta ${alert.category}`}
        >
          Reconocer
        </button>
      )}
      {alert.status !== "resolved" && (
        <button
          type="button"
          onClick={onResolve}
          aria-label={`Resolver alerta ${alert.category}`}
        >
          Resolver
        </button>
      )}
    </li>
  );
}
