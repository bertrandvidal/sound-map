export async function refreshAccessToken() {
  const response = await fetch("/api/refresh", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error("SESSION_EXPIRED");
  const data = await response.json();
  return data.access_token;
}
