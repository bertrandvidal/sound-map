import { useCallback, useEffect, useState } from "react";
import { refreshAccessToken } from "./auth.js";
import LoginButton from "./components/LoginButton.jsx";
import MapView from "./components/MapView.jsx";

export default function App() {
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);
  const [booting, setBooting] = useState(true);

  // Surface an OAuth ?error from the callback redirect, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const e = params.get("error");
    if (e) {
      setError(e);
      window.history.replaceState({}, "", "/");
    }
  }, []);

  // Bootstrap: exchange the session cookie for an access token.
  useEffect(() => {
    let cancelled = false;
    refreshAccessToken()
      .then((t) => {
        if (!cancelled) setToken(t);
      })
      .catch(() => {
        // No valid session — fall through to the login screen.
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A poll hit a 401: try to refresh; only truly log out if that fails.
  const handleTokenExpired = useCallback(async () => {
    try {
      const t = await refreshAccessToken();
      setToken(t);
    } catch {
      setToken(null);
      setError("session_expired");
    }
  }, []);

  if (booting) return null;

  if (token) {
    return <MapView token={token} onTokenExpired={handleTokenExpired} />;
  }

  return <LoginButton error={error} />;
}
