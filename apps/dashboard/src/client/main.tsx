import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

/**
 * Client bootstrap (task 5.1): mounts the React 19 app into #root from
 * index.html. The Express server serves this bundle in production (design
 * §7.1 "Vite static served by Express"); Vite dev serves it with HMR.
 */

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("No se encontró el elemento #root.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
