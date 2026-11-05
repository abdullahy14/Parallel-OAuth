/**
 * Root page — intentionally minimal.
 * This service exposes a single API endpoint: /api/fetch-token
 */
export default function Home() {
  return (
    <main style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h1>Genesys Cloud Auth Token Service</h1>
      <p>
        <strong>Endpoint:</strong> <code>/api/fetch-token</code>
      </p>
      <p>
        <strong>Methods:</strong> GET &nbsp;|&nbsp; POST &nbsp;|&nbsp; OPTIONS
      </p>
      <p>
        See <code>README.md</code> for full API documentation.
      </p>
    </main>
  );
}
