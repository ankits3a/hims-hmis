import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/plex.css"; // self-hosted IBM Plex — see the header there; must precede styles.css
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
