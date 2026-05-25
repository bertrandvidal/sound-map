import 'dotenv/config'
import express from 'express'

const app = express()

const CLIENT_ID = process.env.VITE_SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const REDIRECT_URI = 'http://127.0.0.1:3000/callback'
const FRONTEND_URL = 'http://localhost:5173'

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing VITE_SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env')
  process.exit(1)
}

app.get('/callback', async (req, res) => {
  const { code, error } = req.query

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?error=access_denied`)
  }

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')

  let tokenResponse
  try {
    tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    })
  } catch (err) {
    console.error('Token exchange network error:', err)
    return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`)
  }

  if (!tokenResponse.ok) {
    console.error('Token exchange failed:', tokenResponse.status, await tokenResponse.text())
    return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`)
  }

  const { access_token } = await tokenResponse.json()
  res.redirect(`${FRONTEND_URL}?token=${access_token}`)
})

app.listen(3000, '127.0.0.1', () => {
  console.log('OAuth server listening on http://127.0.0.1:3000')
})
