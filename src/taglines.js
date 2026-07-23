// Static pool baked into the bundle. Selection is pure client-side — never
// hits the backend, so the landing renders even if the API is down.
export const TAGLINES = [
  "See where your music comes from",
  "Every song has a hometown.",
  "Your listening, mapped across the world.",
  "Follow your music around the globe.",
  "A world tour, one track at a time.",
  "Where in the world is your playlist?",
  "Every artist starts somewhere.",
  "Your soundtrack has a map.",
  "From here to everywhere, one song at a time.",
  "Chart the origins of your sound.",
];

export function pickRandomTagline() {
  return TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}
