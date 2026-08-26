#!/usr/bin/env node
/**
 * Fetches the combined Kubernetes OpenAPI (Swagger 2.0) spec straight from the
 * kubernetes/kubernetes repo for one or more versions, and drops each at
 * ./specs/<version>/swagger.json.
 *
 * This is the single-file spec (api/openapi-spec/swagger.json), not the
 * per-API-group v3 split (api/openapi-spec/v3/*.json) - it already has every
 * definition in one flat `definitions` map with plain $ref pointers between
 * them, which is exactly what scripts/gen-reference.mjs needs to resolve
 * cross-links across the whole API surface on one page.
 *
 * Which version(s) to fetch:
 *   - K8S_VERSIONS env var, if set: a comma-separated list, each entry one of
 *       "v1.36.3"      a full version, used as-is
 *       "1.36"         a minor, resolved to its latest patch via
 *                      dl.k8s.io/release/stable-1.36.txt
 *       "eks"          every minor Amazon EKS still offers, standard *and*
 *                      extended support, each resolved to its latest patch
 *       "eks-standard" the same, but only the minors in standard support
 *     Entries may be combined ("1.36,eks") and the result is deduplicated, so
 *     an alias and an explicit minor never build the same version twice. Each
 *     resolved version gets its own ./specs/<version>/ - completely separate
 *     from the others.
 *   - Otherwise, single-version mode (unchanged from before): K8S_VERSION env
 *     var if set, else the latest stable release from dl.k8s.io.
 *
 * Writes ./.k8s-versions.json (the resolved full version list) so the
 * workflow can tell whether anything changed since the last run.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.join(process.cwd(), 'specs');
const VERSIONS_FILE = path.join(process.cwd(), '.k8s-versions.json');

const MINOR_RE = /^v?\d+\.\d+$/;
const EKS_SUPPORT_URL = 'https://endoflife.date/api/v1/products/amazon-eks';

async function resolveMinor(minorEntry) {
  const minor = minorEntry.replace(/^v/, '');
  const res = await fetch(`https://dl.k8s.io/release/stable-${minor}.txt`);
  if (!res.ok) throw new Error(`Could not resolve latest patch for minor ${minorEntry}: ${res.status}`);
  return (await res.text()).trim();
}

/**
 * Expands the "eks" / "eks-standard" aliases into the Kubernetes minors that
 * Amazon EKS currently runs, so the tracked set follows AWS's support calendar
 * instead of a hand-maintained list.
 *
 * Sourced from endoflife.date, not eks:DescribeClusterVersions - that API needs
 * AWS credentials, and this build should stay credential-free. Cross-checked
 * against DescribeClusterVersions on 2026-08-26: both said 1.31 through 1.36.
 *
 * Their flags, per cycle: `isEol` marks the end of EKS *standard* support and
 * `isMaintained` the end of *extended* support, i.e. the point where EKS stops
 * offering the version at all. Do not filter on `isEoes` instead - it is null,
 * not true, for old cycles that never had extended support, which would let
 * long-dead minors back in.
 */
async function resolveEksMinors(standardOnly) {
  const res = await fetch(EKS_SUPPORT_URL, {headers: {accept: 'application/json'}});
  if (!res.ok) throw new Error(`Could not fetch EKS support calendar: ${res.status}`);
  const releases = (await res.json())?.result?.releases;
  if (!Array.isArray(releases)) throw new Error('EKS support calendar had an unexpected shape');
  const minors = releases
    .filter((r) => (standardOnly ? r.isEol === false : r.isMaintained === true))
    .map((r) => r.name);
  // Never silently narrow the build: an empty list here would quietly delete
  // every EKS version page from the deployed site.
  if (minors.length === 0) throw new Error('EKS support calendar returned no supported minors');
  console.log(`  ${standardOnly ? 'eks-standard' : 'eks'} -> ${minors.join(', ')}`);
  return minors;
}

// Each entry expands to one or more full versions.
async function resolveEntry(entry) {
  entry = entry.trim();
  const alias = entry.toLowerCase();
  if (alias === 'eks' || alias === 'eks-standard') {
    const minors = await resolveEksMinors(alias === 'eks-standard');
    return Promise.all(minors.map(resolveMinor));
  }
  if (MINOR_RE.test(entry)) return [await resolveMinor(entry)];
  return [entry.startsWith('v') ? entry : `v${entry}`];
}

async function resolveVersions() {
  if (process.env.K8S_VERSIONS) {
    const entries = process.env.K8S_VERSIONS.split(',').map((s) => s.trim()).filter(Boolean);
    const versions = (await Promise.all(entries.map(resolveEntry))).flat();
    return [...new Set(versions)];
  }
  if (process.env.K8S_VERSION) return [process.env.K8S_VERSION.trim()];
  const res = await fetch('https://dl.k8s.io/release/stable.txt');
  if (!res.ok) throw new Error(`Could not resolve stable k8s version: ${res.status}`);
  return [(await res.text()).trim()];
}

async function fetchOne(version) {
  const url = `https://raw.githubusercontent.com/kubernetes/kubernetes/${version}/api/openapi-spec/swagger.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download swagger.json for ${version}: ${res.status}`);
  const body = await res.text();
  const dir = path.join(OUT_DIR, version);
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'swagger.json'), body);
  console.log(`  ${version}: downloaded swagger.json (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  const versions = await resolveVersions();
  console.log(`Target Kubernetes version(s): ${versions.join(', ')}`);

  await fs.rm(OUT_DIR, {recursive: true, force: true});
  await fs.mkdir(OUT_DIR, {recursive: true});

  for (const version of versions) {
    await fetchOne(version);
  }

  await fs.writeFile(VERSIONS_FILE, JSON.stringify(versions.sort().reverse(), null, 2) + '\n');
  console.log(`Done. Wrote .k8s-versions.json = [${versions.join(', ')}]`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
