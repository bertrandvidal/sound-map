import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyFavicon } from "./favicon.js";
import "./index.css";

applyFavicon(document, import.meta.env.DEV);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
