import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lookupArtistLocation } from '../geo.js'

describe('lookupArtistLocation', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('returns null when MusicBrainz finds no artists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ artists: [] })
    }))
    expect(await lookupArtistLocation('Unknown Artist XYZ')).toBeNull()
  })

  it('returns null when artist has no begin-area or area', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ artists: [{ name: 'Test' }] })
    }))
    expect(await lookupArtistLocation('Test')).toBeNull()
  })

  it('returns null when Nominatim finds no results for the area', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ artists: [{ name: 'Test', 'begin-area': { name: 'Nowhere' } }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      })
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupArtistLocation('Test')).toBeNull()
  })

  it('returns lat/lng/placeName when both APIs succeed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          artists: [{ name: 'Kendrick Lamar', 'begin-area': { name: 'Compton' } }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ lat: '33.8958', lon: '-118.2201' }])
      })
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupArtistLocation('Kendrick Lamar')).toEqual({
      lat: 33.8958,
      lng: -118.2201,
      placeName: 'Compton',
    })
  })

  it('falls back to area.name when begin-area is absent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          artists: [{ name: 'Test', area: { name: 'London' } }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ lat: '51.5074', lon: '-0.1278' }])
      })
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupArtistLocation('Test')).toEqual({
      lat: 51.5074,
      lng: -0.1278,
      placeName: 'London',
    })
  })

  it('returns null when MusicBrainz returns an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    expect(await lookupArtistLocation('Test Artist')).toBeNull()
  })

  it('returns null when Nominatim returns an HTTP error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ artists: [{ name: 'Test', 'begin-area': { name: 'Somewhere' } }] })
      })
      .mockResolvedValueOnce({ ok: false, status: 429 })
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupArtistLocation('Test Artist')).toBeNull()
  })
})
