// Token launch radar: the program behind the dashboard in this repository.
//
// It reads the sealed DefiLlama snapshot (at /input/snapshot.json in the
// grader, or wherever --input points), scores every pre-token protocol with
// the model in lib/model.ts, and writes the run's outputs:
//
//   board.json    the ranked board, one row per protocol, farm plan included
//   data.js       the same board shaped for the page, as window.RADAR
//   dashboard/    a copy of this repository's static page
//   screenshots/  a copy of this repository's three captures of that page
//   dossier.json  the judge's summary of the dashboard, written last with
//                 buildDossier from vendor/makefun-board.ts, so the scorer
//                 can rebuild it from the same /output and compare bytes
//
// Node 22, standard library only, no network. Outside the grader's container
// MAKEFUN_OUTPUT_DIR stands in for /output:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildData, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The dossier caps the scorer rebuilds with: 64 KiB of source text, at most 4 screenshots of 512 KiB. */
const DOSSIER_TEXT_MAX = 65_536;
const DOSSIER_SHOTS = { max: 4, max_bytes: 524_288 };
const DOSSIER_DASHBOARD = { max_files: 400, max_bytes: 4_194_304 };

/** A screenshot or dashboard file name the dossier accepts. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name value` or `--name=value` from the arguments, else the fallback. */
function readArg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at !== -1 && at + 1 < args.length) return args[at + 1]!;
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? fallback : inline.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token-radar: ${message}\n`);
  process.exit(1);
}

// --- the snapshot -----------------------------------------------------------

const inputArg = readArg('input', '/input');
const inputPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputPath)) {
  process.stderr.write(`token-radar: no snapshot at ${inputPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));

// --- the board --------------------------------------------------------------

const { board, data } = buildData(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model produced a board the gate refuses: ${issue}`);

// --- the outputs ------------------------------------------------------------

const outDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(data));

/** Copy a directory's regular files into the output, skipping dotfiles; returns the names copied. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    names.push(name);
  }
  return names;
}

const pageFiles = copyTree(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
if (pageFiles.length === 0) fail('dashboard/ is empty: the page is part of the entry');

const shots = copyTree(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
for (const name of shots) {
  if (!PLAIN_NAME.test(name)) fail(`screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters`);
}

// The dossier is written last and only over a complete set of captures: with
// none in the repository there is nothing for it to summarise, so a local
// development run writes the board and the page and says so, while a run of
// the submitted repository, which carries its three screenshots, writes it.
if (shots.length === 0) {
  process.stderr.write('token-radar: screenshots/ is empty, dossier.json skipped (development run)\n');
} else {
  if (shots.length < 3) fail(`screenshots/ holds ${shots.length} image(s): the entry hands in 3, the board, a detail view and a filtered view`);
  writeFileSync(
    join(outDir, 'dossier.json'),
    buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_MAX, screenshots: DOSSIER_SHOTS, dashboard: DOSSIER_DASHBOARD }),
  );
}

process.stdout.write(
  `token-radar: snapshot of ${snapshot.as_of}: ${snapshot.protocols.length} protocols, ` +
    `${data.stats.watchlist_covered}/${data.stats.watchlist_total} watchlist covered, ${board.length} rows ranked ` +
    `(${data.stats.early_rows} early below the floor), ${data.stats.live_shown} live-token protocols set aside\n` +
    `token-radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images)` +
    `${shots.length === 0 ? '' : ' and dossier.json'} into ${outDir}\n`,
);
