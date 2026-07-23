import { useCallback, useEffect, useState } from "react";
import { refreshAccessToken } from "./auth.js";
import LandingPage from "./components/LandingPage.jsx";
import MapView from "./components/MapView.jsx";
import { devLog } from "./devLog.js";

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
    devLog("[app] bootstrapping session");
    refreshAccessToken()
      .then((t) => {
        if (cancelled) return;
        devLog("[app] session restored");
        setToken(t);
      })
      .catch(() => {
        devLog("[app] no active session, showing login");
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
    devLog("[app] token expired, refreshing");
    try {
      const t = await refreshAccessToken();
      devLog("[app] token refreshed");
      setToken(t);
    } catch {
      devLog("[app] refresh failed, logging out");
      setToken(null);
      setError("session_expired");
    }
  }, []);

  if (booting) return null;

  if (token) {
    return <MapView token={token} onTokenExpired={handleTokenExpired} />;
  }

  return <LandingPage error={error} />;
}
