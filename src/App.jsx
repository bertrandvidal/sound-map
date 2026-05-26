import { useEffect, useState } from "react";
import LoginButton from "./components/LoginButton.jsx";
import MapView from "./components/MapView.jsx";

export default function App() {
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    const e = params.get("error");
    if (t) setToken(decodeURIComponent(t));
    if (e) setError(e);
    if (t || e) window.history.replaceState({}, "", "/");
  }, []);

  if (token) {
    return (
      <MapView
        token={token}
        onSessionExpired={() => {
          setToken(null);
          setError("session_expired");
        }}
      />
    );
  }

  return <LoginButton error={error} />;
}
