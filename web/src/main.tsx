import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { GameProvider } from "./state";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GameProvider>
      <App />
    </GameProvider>
  </StrictMode>,
);
