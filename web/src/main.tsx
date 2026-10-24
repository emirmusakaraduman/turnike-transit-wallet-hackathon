import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Rider from "./pages/Rider";
import Gate from "./pages/Gate";
import Operator from "./pages/Operator";
import { getLang } from "./lib/i18n";
import "./index.css";

document.documentElement.lang = getLang();

function App() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const path = hash.split("?")[0];
  return path === "#/gate" ? <Gate /> : path === "#/operator" ? <Operator /> : <Rider />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
