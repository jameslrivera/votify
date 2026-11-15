import { Kiosk } from "./kiosk/Kiosk.tsx";
import { Results } from "./results/Results.tsx";

export function App() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/kiosk") return <Kiosk />;
  if (path === "/results") return <Results />;
  return (
    <main className="home">
      <h1>Votify</h1>
      <p className="muted">Private. Verifiable. Secure.</p>
      <a className="button primary" href="/kiosk">
        Open the voting kiosk
      </a>
      <a className="button" href="/results">
        See live results
      </a>
    </main>
  );
}
