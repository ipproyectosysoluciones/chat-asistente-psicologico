// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "./LoginPage";

/**
 * Supervisor login form (task 5.1 frontend): accessible labels, client-side
 * empty-submit validation, loading state, and RFC 7807 detail on failure.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("renders accessible labels for email and password", () => {
    render(<LoginPage onSuccess={vi.fn()} />);

    expect(screen.getByLabelText("Correo electrónico")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ingresar" })).toBeInTheDocument();
  });

  it("shows an error and does not submit when the form is empty", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage onSuccess={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "El correo electrónico y la contraseña son obligatorios."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls onSuccess with the user after a successful login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          token: "jwt-token",
          expiresIn: 900,
          user: { id: "u1", email: "sup@example.com", role: "supervisor" },
        })
      )
    );
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<LoginPage onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText("Correo electrónico"), "sup@example.com");
    await user.type(screen.getByLabelText("Contraseña"), "s3cret");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(onSuccess).toHaveBeenCalledWith(
      { id: "u1", email: "sup@example.com", role: "supervisor" },
      "jwt-token"
    );
  });

  it("shows the server RFC 7807 detail when login fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          type: "https://api.chatcap.app/errors/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "Invalid credentials.",
          code: "unauthorized",
        })
      )
    );
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<LoginPage onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText("Correo electrónico"), "sup@example.com");
    await user.type(screen.getByLabelText("Contraseña"), "wrong");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid credentials."
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
