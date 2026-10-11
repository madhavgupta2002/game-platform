import { useEffect, useState } from "react";
import { games } from "./games.js";

const byId = Object.fromEntries(games.map((g) => [g.id, g]));
const readHash = () => window.location.hash.replace(/^#\/?/, "");

export default function App() {
  const [id, setId] = useState(readHash);

  useEffect(() => {
    const onHash = () => setId(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const game = byId[id];
  return game ? <Player game={game} /> : <Library />;
}

function Library() {
  return (
    <main className="library">
      <header>
        <h1>Game Platform</h1>
        <p>{games.length} games, one place.</p>
      </header>
      <div className="grid">
        {games.map((g) => (
          <a key={g.id} className="card" href={`#/${g.id}`} style={{ "--accent": g.accent }}>
            <h2>{g.title}</h2>
            <p>{g.blurb}</p>
            <div className="tags">
              {g.tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          </a>
        ))}
      </div>
    </main>
  );
}

function Player({ game }) {
  return (
    <div className="player">
      <nav>
        <a href="#/">← All games</a>
        <strong>{game.title}</strong>
      </nav>
      <iframe
        key={game.id}
        title={game.title}
        src={`${import.meta.env.BASE_URL}games/${game.id}/index.html`}
        allow={game.allow}
      />
    </div>
  );
}
