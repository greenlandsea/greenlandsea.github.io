import React from "react";
import { createRoot } from "react-dom/client";
import App from "./src/App";
import "./src/styles.css";

export function renderToDOM(container: HTMLElement | null) {
  if (!container) throw new Error("Missing #app container");
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

