// Registry of games. Each game lives in public/games/<id>/index.html and is
// embedded in an iframe, so games stay self-contained and don't collide.
export const games = [
  {
    id: "flappy-bird",
    title: "Flappy Bird",
    blurb: "Tap to flap through the pipes.",
    tags: ["arcade"],
    accent: "#f5c542"
  },
  {
    id: "comet-critters",
    title: "Comet Critters",
    blurb: "Sling comets at towers and pop every invading Gloop.",
    tags: ["physics", "puzzle"],
    accent: "#7c5cff"
  },
  {
    id: "bloom-garden",
    title: "Bloom",
    blurb: "Draw a living garden with your hand. Needs a webcam.",
    tags: ["creative", "webcam"],
    accent: "#ff7eb6",
    allow: "camera"
  }
];