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
 *   - K8S_VERSIONS env var, if set: a comma-separated list, each entry either
 *     a full version ("v1.36.3") used as-is, or a minor-only version
 *     ("1.36") resolved to its latest patch via dl.k8s.io/release/stable-1.36.txt.
 *     Each is built into its own ./specs/<version>/ - completely separate
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

async function resolveEntry(entry) {
  entry = entry.trim();
  if (MINOR_RE.test(entry)) {
    const minor = entry.replace(/^v/, '');
    const res = await fetch(`https://dl.k8s.io/release/stable-${minor}.txt`);
    if (!res.ok) throw new Error(`Could not resolve latest patch for minor ${entry}: ${res.status}`);
    return (await res.text()).trim();
  }
  return entry.startsWith('v') ? entry : `v${entry}`;
}

async function resolveVersions() {
  if (process.env.K8S_VERSIONS) {
    const entries = process.env.K8S_VERSIONS.split(',').map((s) => s.trim()).filter(Boolean);
    const versions = await Promise.all(entries.map(resolveEntry));
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
