/**
 * One snapshot run: fetch the full token universe from the live API, store it
 * in the snapshot store, and write a trimmed JSON export (no long description
 * blobs) under data/snapshots/ for easy inspection.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TokenizedStocksClient } from "./client.ts";
import { SnapshotStore, SNAPSHOT_JSON_DIR } from "./store.ts";
import type { TokenizedStock } from "./types.ts";

export interface SnapshotResult {
  runId: number;
  takenAt: string;
  tokenCount: number;
  withNav: number;
  tokens: TokenizedStock[];
  jsonPath: string;
}

export async function runSnapshot(
  client = new TokenizedStocksClient(),
  store = new SnapshotStore(),
): Promise<SnapshotResult> {
  const takenAt = new Date();
  const tokens = await client.listAllTokens(500);
  const runId = store.recordSnapshot(tokens, takenAt);

  mkdirSync(SNAPSHOT_JSON_DIR, { recursive: true });
  const trimmed = tokens.map(({ description, ...rest }) => rest);
  const jsonPath = join(
    SNAPSHOT_JSON_DIR,
    `run-${runId}-${takenAt.toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    jsonPath,
    JSON.stringify({ runId, takenAt: takenAt.toISOString(), tokens: trimmed }, null, 2),
  );

  return {
    runId,
    takenAt: takenAt.toISOString(),
    tokenCount: tokens.length,
    withNav: tokens.filter((t) => t.navPrice !== undefined).length,
    tokens,
    jsonPath,
  };
}
