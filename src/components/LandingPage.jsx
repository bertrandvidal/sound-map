import { useMemo } from "react";
import { pickRandomTagline } from "../taglines.js";
import { ACCENT, MUTED, STAGE, TEXT } from "../theme.js";
import WorldMapBackdrop from "./WorldMapBackdrop.jsx";

const ERROR_MESSAGES = {
  access_denied: { text: "Access denied. Please try again.", color: "#f15e6c" },
  token_exchange_failed: {
    text: "Login failed. Please try again.",
    color: "#f15e6c",
  },
  session_expired: {
    text: "Session expired (1 hour limit). Please log in again.",
    color: "#f5c542",
  },
  state_mismatch: {
    text: "Login could not be verified. Please try again.",
    color: "#f15e6c",
  },
};

export default function LandingPage({ error }) {
  // Pick once per page load, not on every render. Pure client-side.
  const tagline = useMemo(() => pickRandomTagline(), []);
  const err = ERROR_MESSAGES[error];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: STAGE,
        overflow: "hidden",
        fontFamily: "sans-serif",
      }}
    >
      <WorldMapBackdrop />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 24,
        }}
      >
        {/* radial scrim keeps the centered content legible over the art */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse 60% 55% at 50% 45%, rgba(0,0,0,0.85), rgba(0,0,0,0) 70%)",
            pointerEvents: "none",
          }}
        />

        <h1
          style={{
            position: "relative",
            color: TEXT,
            fontSize: "clamp(40px, 9vw, 64px)",
            fontWeight: 800,
            letterSpacing: "-2px",
            margin: 0,
          }}
        >
          sound-map
        </h1>

        <p
          style={{
            position: "relative",
            color: MUTED,
            fontSize: "clamp(14px, 3.5vw, 18px)",
            marginTop: 12,
          }}
        >
          {tagline}
        </p>

        {err && (
          <p
            style={{
              position: "relative",
              color: err.color,
              fontSize: "clamp(13px, 3vw, 15px)",
              marginTop: 12,
            }}
          >
            {err.text}
          </p>
        )}

        <a
          href="/api/login"
          style={{
            position: "relative",
            textDecoration: "none",
            marginTop: 28,
          }}
        >
          <button
            type="button"
            style={{
              background: ACCENT,
              color: "#000",
              fontWeight: 700,
              fontSize: "clamp(14px, 3.5vw, 16px)",
              padding: "14px 32px",
              border: "none",
              borderRadius: 999,
              cursor: "pointer",
              boxShadow: "0 6px 24px rgba(29,185,84,0.3)",
            }}
          >
            Log in with Spotify
          </button>
        </a>

        {/* Playback controls go through Spotify's player endpoints, which the
            Web API restricts to Premium accounts. Set expectations before the
            user logs in rather than surfacing a 403 afterwards. */}
        <p
          style={{
            position: "relative",
            color: MUTED,
            fontSize: "clamp(11px, 2.6vw, 13px)",
            marginTop: 16,
            maxWidth: 380,
            opacity: 0.8,
          }}
        >
          Some features may require a Spotify Premium account.
        </p>
      </div>
    </div>
  );
}
