"use client";

import { useEffect, useState, type FormEvent, type JSX } from "react";

import {
  fetchLegalFrameworks,
  frameworksErrorMessage,
  publishLegalFramework,
  type LegalFramework,
  type PublishTermsInput,
} from "./api";

/**
 * Legal frameworks page (Phase 5.8 frontend): supervisors see the published
 * terms versions and can publish a new version ("Publicar nueva versión") per
 * country/framework. The token lives in sessionStorage ONLY — never logged
 * (AGENTS.md, clinical data). No terms text is ever `console.log`-ged.
 */

type Notice =
  | { type: "error"; message: string }
  | { type: "success"; message: string };

const EMPTY_FORM: PublishTermsInput = {
  countryCode: "",
  frameworkCode: "",
  noticeText: "",
};

export interface LegalFrameworksPageProps {
  token: string;
}

export function LegalFrameworksPage({
  token,
}: LegalFrameworksPageProps): JSX.Element {
  const [frameworks, setFrameworks] = useState<LegalFramework[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [form, setForm] = useState<PublishTermsInput>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  function load(): void {
    setLoading(true);
    setListError(undefined);
    void fetchLegalFrameworks(token)
      .then((result) => {
        setFrameworks(result);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        setListError(frameworksErrorMessage(caught));
        setLoading(false);
      });
  }

  useEffect(() => {
    load();
  }, [token]);

  function handleFieldChange(field: keyof PublishTermsInput, value: string): void {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  async function handlePublish(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setNotice(undefined);
    try {
      const created = await publishLegalFramework(token, form);
      setFrameworks((previous) => [created, ...previous]);
      setForm(EMPTY_FORM);
      setNotice({
        type: "success",
        message: `Versión ${created.termsVersion} de ${created.frameworkCode} publicada.`,
      });
    } catch (caught: unknown) {
      setNotice({ type: "error", message: frameworksErrorMessage(caught) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="legal-frameworks" aria-label="Marcos legales">
      <h2>Marcos legales</h2>

      {loading ? (
        <p className="legal-frameworks__status" aria-live="polite">
          Cargando marcos legales…
        </p>
      ) : listError !== undefined ? (
        <div className="legal-frameworks__error" role="alert">
          <p>{listError}</p>
          <button type="button" onClick={() => load()}>
            Reintentar
          </button>
        </div>
      ) : (
        <table className="legal-frameworks__table">
          <thead>
            <tr>
              <th scope="col">País</th>
              <th scope="col">Marco</th>
              <th scope="col">Versión</th>
              <th scope="col">Activo</th>
            </tr>
          </thead>
          <tbody>
            {frameworks.map((row) => (
              <tr key={row.id}>
                <td>{row.countryCode}</td>
                <td>{row.frameworkCode}</td>
                <td>{row.termsVersion}</td>
                <td>{row.active ? "Sí" : "No"}</td>
              </tr>
            ))}
            {frameworks.length === 0 && (
              <tr>
                <td colSpan={4}>Sin marcos legales publicados.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <form
        className="legal-frameworks__form"
        onSubmit={(event) => void handlePublish(event)}
        aria-label="Publicar nueva versión"
      >
        <h3>Publicar nueva versión</h3>
        <label>
          <span>Código de país</span>
          <input
            type="text"
            value={form.countryCode}
            onChange={(event) =>
              handleFieldChange("countryCode", event.target.value)
            }
            aria-label="countryCode"
            required
          />
        </label>
        <label>
          <span>Código de marco</span>
          <input
            type="text"
            value={form.frameworkCode}
            onChange={(event) =>
              handleFieldChange("frameworkCode", event.target.value)
            }
            aria-label="frameworkCode"
            required
          />
        </label>
        <label>
          <span>Texto de aviso</span>
          <textarea
            value={form.noticeText}
            onChange={(event) =>
              handleFieldChange("noticeText", event.target.value)
            }
            aria-label="noticeText"
            required
          />
        </label>
        <button type="submit" disabled={submitting}>
          Publicar nueva versión
        </button>
      </form>

      {notice !== undefined && (
        <p
          className={
            notice.type === "error"
              ? "legal-frameworks__notice legal-frameworks__notice--error"
              : "legal-frameworks__notice"
          }
          role={notice.type === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}
    </section>
  );
}
