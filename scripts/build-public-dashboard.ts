/**
 * Build the STATIC public dashboard for GitHub Pages (docs/).
 *
 * Renders the exact same two pages as the live server (apps/web) from the
 * project's real snapshot store, then adapts them for static hosting:
 *   - nav links rewritten to index.html / agent.html
 *   - the live pages' 120s auto-refresh meta removed
 *   - an "Onchain attestations" panel injected into the agent page, read
 *     live from the DecisionAttestor contract on Base Sepolia at build
 *     time (count + one row per attestation: decision hash, snapshot run,
 *     attester, timestamp) — no invented numbers, everything below comes
 *     from the store or the chain
 *   - a footer note stamping when this snapshot was generated and from
 *     which snapshot run
 *
 * Output: docs/index.html, docs/agent.html, docs/.nojekyll
 * Run:    npm run web:static     (re-run as snapshots accumulate)
 * Publish: push docs/ and enable GitHub Pages (source: main branch /docs)
 *          → https://xcaracalid.github.io/base-stocks-agent/
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotStore } from "../packages/data/src/store.ts";
import { functionSelector } from "../packages/data/src/keccak.ts";
import { agentPage, watchlistPage } from "../apps/web/src/server.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "docs");

const ATTESTOR_ADDRESS = "0x7ec77bAa144eb36554d50d425A57330cbF38B687";
const SEPOLIA_RPC = "https://sepolia.base.org";
const BASESCAN = `https://sepolia.basescan.org/address/${ATTESTOR_ADDRESS}`;

// ------------------------------------------------------------ chain reads

interface Attestation {
  index: number;
  decisionHash: string;
  snapshotRunId: number;
  attester: string;
  attestedAtSec: number;
}

async function ethCall(data: string): Promise<string> {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: ATTESTOR_ADDRESS, data }, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`Base Sepolia RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(`Base Sepolia RPC error: ${body.error.message}`);
  if (!body.result) throw new Error("Base Sepolia RPC: empty result");
  return body.result;
}

function wordAt(hex: string, byteOffset: number): bigint {
  return BigInt("0x" + hex.slice(2 + byteOffset * 2, 2 + (byteOffset + 32) * 2));
}

function bytesAt(hex: string, byteOffset: number, len: number): string {
  return "0x" + hex.slice(2 + byteOffset * 2, 2 + (byteOffset + len) * 2);
}

async function readAttestations(): Promise<Attestation[]> {
  const countHex = await ethCall(functionSelector("attestationCount()"));
  const count = Number(wordAt(countHex, 0));
  const out: Attestation[] = [];
  for (let i = 0; i < count; i++) {
    const data =
      functionSelector("getAttestation(uint256)") +
      i.toString(16).padStart(64, "0");
    const hex = await ethCall(data);
    // getAttestation returns the Attestation struct; depending on the ABI
    // encoder the tuple may be preceded by a 0x20 offset word.
    const base = wordAt(hex, 0) === 32n ? 32 : 0;
    out.push({
      index: i,
      decisionHash: bytesAt(hex, base, 32),
      snapshotRunId: Number(wordAt(hex, base + 32)),
      attester: "0x" + hex.slice(2 + (base + 96) * 2 + 24, 2 + (base + 128) * 2),
      attestedAtSec: Number(wordAt(hex, base + 128)),
    });
  }
  return out;
}

// ------------------------------------------------------------ html helpers

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

function timeStr(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

function attestationPanel(
  attestations: Attestation[],
  decisionIdByRun: Map<number, number>,
): string {
  const rows = attestations
    .map((a) => {
      const decisionId = decisionIdByRun.get(a.snapshotRunId);
      const when = new Date(a.attestedAtSec * 1000).toISOString();
      return `<tr>
        <td class="r num">${a.index}</td>
        <td>${decisionId !== undefined ? `Decision #${decisionId}` : `<span class="muted">—</span>`}</td>
        <td class="r num">${a.snapshotRunId}</td>
        <td class="num" title="${esc(a.decisionHash)}">${esc(shortHash(a.decisionHash))}</td>
        <td class="num">${timeStr(when)}</td>
        <td class="num" title="${esc(a.attester)}">${esc(shortHash(a.attester))}</td>
      </tr>`;
    })
    .join("\n");

  return `  <section class="panel">
    <h2>Onchain attestations — DecisionAttestor (Base Sepolia)</h2>
    <p class="sub">Every decision record below is attested in the DecisionAttestor contract on Base Sepolia
    (chain 84532): <a href="${BASESCAN}">${ATTESTOR_ADDRESS}</a> — <strong>${attestations.length} attestation(s)</strong>
    recorded so far, read from the chain when this page was generated. Each attestation stores
    keccak256 of the record's canonical JSON, and its metadata URI is a data: URI carrying exactly those
    bytes — so any record can be verified from chain data alone, without trusting this page.</p>
    <div class="tblwrap"><table>
      <thead><tr><th class="r">#</th><th>Decision</th><th class="r">Snapshot run</th>
      <th>Decision hash</th><th>Attested at</th><th>Attester</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted">No attestations recorded yet.</td></tr>`}</tbody>
    </table></div>
  </section>
`;
}

// ------------------------------------------------------------------ build

const store = new SnapshotStore();
try {
  const runs = store.runCount();
  const decisions = store.listDecisions();
  const decisionIdByRun = new Map<number, number>();
  for (const d of decisions) {
    if (d.runId !== null && d.runId !== undefined) decisionIdByRun.set(d.runId, d.id);
  }

  const attestations = await readAttestations();
  const generatedAt = new Date().toISOString();

  const adapt = (html: string): string =>
    html
      .replace(`<meta http-equiv="refresh" content="120">\n`, "")
      .replaceAll(`href="/agent"`, `href="agent.html"`)
      .replaceAll(`href="/"`, `href="index.html"`)
      .replace(
        `<footer>\n  <div class="wrap">`,
        `<footer>\n  <div class="wrap">\n    <p><strong>Static public snapshot</strong> of the agent's dashboard, generated ${timeStr(generatedAt)} ` +
          `from the project's snapshot store (snapshot #${runs}) with attestation data read from Base Sepolia at generation time. ` +
          `Rebuilt as snapshots accumulate — regenerate with <code>npm run web:static</code>.</p>`,
      );

  let watchlist = adapt(watchlistPage(store));
  let agent = adapt(agentPage(store));

  // The live page still carries the pre-attestation copy in the decision
  // log intro; the static page replaces it and adds the panel (the live
  // server copy is untouched).
  const staleCopy =
    "Onchain attestation of these records is the next build step; until then the log below is the stored record itself.";
  if (!agent.includes(staleCopy)) {
    throw new Error("static build: decision-log intro copy not found — refusing to guess");
  }
  agent = agent.replace(
    staleCopy,
    "Every record is attested onchain in the DecisionAttestor log (panel above) and can be verified by recomputing the canonical hash of its stored JSON.",
  );
  const logAnchor = `  <section class="panel">\n    <h2>Decision log</h2>`;
  if (!agent.includes(logAnchor)) {
    throw new Error("static build: decision log anchor not found — refusing to guess");
  }
  agent = agent.replace(logAnchor, attestationPanel(attestations, decisionIdByRun) + logAnchor);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), watchlist);
  writeFileSync(join(outDir, "agent.html"), agent);
  writeFileSync(join(outDir, ".nojekyll"), "");

  console.log(
    `Static dashboard written to docs/ — index.html (${watchlist.length} bytes), agent.html (${agent.length} bytes)\n` +
      `Data: snapshot #${runs}, ${decisions.length} decision record(s), ${attestations.length} onchain attestation(s) (Base Sepolia).`,
  );
} finally {
  store.close();
}
