#!/usr/bin/env node
/**
 * Builds one self-contained static HTML page per version found under
 * ./specs/<version>/swagger.json - every Kubernetes API type on one page,
 * each with its own anchor, with every field that references another type
 * rendered as a same-page link to it.
 *
 * This mirrors the browsing model of the upstream reference at
 * https://kubernetes.io/docs/reference/generated/kubernetes-api/ (click a
 * field's type, jump straight to its definition, no page reloads) rather than
 * the "one page per operation" model of typical REST API doc generators,
 * which don't cross-link shared types at all.
 *
 * Versions are fully independent of each other - each gets its own anchors,
 * its own sidebar, computed only from that version's spec. A small version
 * switcher links between them and back to a landing page, but every page is
 * still a standalone file that works fine on its own.
 *
 * Output:
 *   ./build/index.html            - landing page listing all versions
 *   ./build/<version>/index.html  - one per version
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const SPECS_DIR = path.join(process.cwd(), 'specs');
const OUT_DIR = path.join(process.cwd(), 'build');

const VERSION_RE = /^v[0-9]+((alpha|beta)[0-9]+)?$/;
const NOISE_SEGMENTS = new Set(['io', 'k8s', 'api', 'apis', 'pkg', 'apimachinery']);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseSemver(v) {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function compareVersionsDesc(a, b) {
  const [pa, pb] = [parseSemver(a), parseSemver(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

// Parses a definition name like "io.k8s.api.core.v1.Pod" or
// "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta" into {group, version, kind}
// as a fallback for types that don't carry x-kubernetes-group-version-kind
// (only actual top-level resources do - everything else is a plain nested type).
function parseDottedName(name) {
  const segments = name.split('.');
  const kind = segments[segments.length - 1];
  const versionIdx = segments.findIndex((s) => VERSION_RE.test(s));
  const version = versionIdx >= 0 ? segments[versionIdx] : '';
  const groupEnd = versionIdx >= 0 ? versionIdx : segments.length - 1;
  const group = segments.slice(0, groupEnd).filter((s) => !NOISE_SEGMENTS.has(s)).join('.') || 'core';
  return {group, version, kind};
}

function buildMeta(definitions) {
  const meta = new Map();
  const usedAnchors = new Set();
  for (const [name, schema] of Object.entries(definitions)) {
    const gvkList = schema['x-kubernetes-group-version-kind'];
    const gvk = Array.isArray(gvkList) && gvkList.length > 0 ? gvkList[0] : null;
    const parsed = parseDottedName(name);
    const group = gvk ? (gvk.group || 'core') : parsed.group;
    const version = gvk ? gvk.version : parsed.version;
    const kind = gvk ? gvk.kind : parsed.kind;

    let anchor = slugify(`${kind}-${version}-${group}`);
    if (usedAnchors.has(anchor)) anchor = slugify(`${anchor}-${name}`);
    usedAnchors.add(anchor);

    meta.set(name, {name, group, version, kind, anchor, isResource: !!gvk, schema});
  }
  return meta;
}

function buildOperationsIndex(paths) {
  const ops = new Map(); // key: group|version|kind -> [{action, method, path}]
  for (const [urlPath, methods] of Object.entries(paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!op || typeof op !== 'object' || !op['x-kubernetes-group-version-kind']) continue;
      const gvk = op['x-kubernetes-group-version-kind'];
      const key = `${gvk.group || 'core'}|${gvk.version}|${gvk.kind}`;
      if (!ops.has(key)) ops.set(key, []);
      ops.get(key).push({
        action: op['x-kubernetes-action'] || method,
        method: method.toUpperCase(),
        path: urlPath,
      });
    }
  }
  return ops;
}

function resolveType(fragment, meta) {
  if (!fragment) return {kind: 'primitive', label: 'object'};
  if (fragment.$ref) {
    const name = fragment.$ref.replace('#/definitions/', '');
    const m = meta.get(name);
    if (!m) return {kind: 'primitive', label: name.split('.').pop()};
    return {kind: 'ref', label: m.kind, href: `#${m.anchor}`};
  }
  if (fragment.type === 'array') {
    return {kind: 'array', of: resolveType(fragment.items, meta)};
  }
  if (fragment.type === 'object' && fragment.additionalProperties && typeof fragment.additionalProperties === 'object') {
    return {kind: 'map', of: resolveType(fragment.additionalProperties, meta)};
  }
  let label = fragment.type || 'object';
  if (fragment.format) label += ` (${fragment.format})`;
  return {kind: 'primitive', label};
}

function renderType(t) {
  if (t.kind === 'ref') return `<a href="${t.href}" class="type-link">${escapeHtml(t.label)}</a>`;
  if (t.kind === 'array') return `${renderType(t.of)}[]`;
  if (t.kind === 'map') return `map[string]${renderType(t.of)}`;
  return `<span class="type-prim">${escapeHtml(t.label)}</span>`;
}

function renderDescription(desc) {
  if (!desc) return '';
  const paragraphs = desc.split(/\n\s*\n/).map((p) => escapeHtml(p.replace(/\s*\n\s*/g, ' ').trim()));
  return paragraphs.filter(Boolean).map((p) => `<p>${p}</p>`).join('\n');
}

function renderFieldsTable(schema, meta) {
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const rows = Object.entries(props)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fieldName, fieldSchema]) => {
      const type = resolveType(fieldSchema, meta);
      const req = required.has(fieldName) ? '<span class="required" title="required">*</span>' : '';
      return `<tr>
        <td class="field-name"><code>${escapeHtml(fieldName)}</code>${req}</td>
        <td class="field-type">${renderType(type)}</td>
        <td class="field-desc">${renderDescription(fieldSchema.description)}</td>
      </tr>`;
    });
  if (rows.length === 0) return '';
  return `<table class="fields">
    <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>`;
}

function renderOperations(m, opsIndex) {
  const key = `${m.group}|${m.version}|${m.kind}`;
  const ops = opsIndex.get(key);
  if (!ops || ops.length === 0) return '';
  const rows = [...ops]
    .sort((a, b) => a.action.localeCompare(b.action) || a.path.localeCompare(b.path))
    .map((op) => `<tr>
      <td><code class="verb verb-${escapeHtml(op.method.toLowerCase())}">${escapeHtml(op.method)}</code></td>
      <td>${escapeHtml(op.action)}</td>
      <td><code class="op-path">${escapeHtml(op.path)}</code></td>
    </tr>`);
  return `<details class="operations">
    <summary>Operations (${ops.length})</summary>
    <table class="ops-table">
      <thead><tr><th>Method</th><th>Action</th><th>Path</th></tr></thead>
      <tbody>${rows.join('\n')}</tbody>
    </table>
  </details>`;
}

function renderSection(m, meta, opsIndex) {
  return `<section id="${m.anchor}" class="entity${m.isResource ? ' is-resource' : ''}">
    <h2>${escapeHtml(m.kind)} <span class="badge">${escapeHtml(m.version)}${m.group ? ' ' + escapeHtml(m.group) : ''}</span></h2>
    ${renderDescription(m.schema.description)}
    ${m.isResource ? renderOperations(m, opsIndex) : ''}
    ${renderFieldsTable(m.schema, meta)}
  </section>`;
}

function renderSidebarGroups(groups) {
  const groupNames = [...groups.keys()].sort();
  const blocks = groupNames.map((groupName) => {
    const entries = groups.get(groupName).sort((a, b) => {
      if (a.isResource !== b.isResource) return a.isResource ? -1 : 1;
      return a.kind.localeCompare(b.kind);
    });
    const links = entries.map((m) => `<a href="#${m.anchor}" data-name="${escapeHtml(m.kind.toLowerCase())}" class="${m.isResource ? 'is-resource' : ''}">${escapeHtml(m.kind)}</a>`).join('\n');
    return `<details class="nav-group">
      <summary>${escapeHtml(groupName)}</summary>
      ${links}
    </details>`;
  });
  return blocks.join('\n');
}

function renderVersionSwitcher(currentVersion, allVersions) {
  if (allVersions.length <= 1) return '';
  const items = allVersions.map((v) => v === currentVersion
    ? `<span class="version-pill version-current">${escapeHtml(v)}</span>`
    : `<a class="version-pill" href="../${escapeHtml(v)}/index.html">${escapeHtml(v)}</a>`).join('\n');
  return `<div class="version-switcher">
    <a class="version-pill all-versions" href="../index.html">All versions</a>
    ${items}
  </div>`;
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --bg-alt: #f6f7f9;
  --fg: #1a1d23;
  --fg-muted: #5b6270;
  --border: #e2e5ea;
  --accent: #3b5bdb;
  --accent-soft: #eef1fd;
  --code-bg: #f0f1f4;
  --resource-tint: #f4f8ff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --bg-alt: #1b1e24;
    --fg: #e6e8eb;
    --fg-muted: #9aa1ac;
    --border: #2b2f37;
    --accent: #7a9bff;
    --accent-soft: #1f2740;
    --code-bg: #20242c;
    --resource-tint: #182035;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--fg);
  display: flex;
  min-height: 100vh;
}
code, .type-prim, .type-link, .op-path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

#sidebar {
  width: 300px;
  flex-shrink: 0;
  height: 100vh;
  position: sticky;
  top: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-alt);
  padding: 1rem;
}
#sidebar h1 { font-size: 1rem; margin: 0 0 .25rem; }
#sidebar .subtitle { font-size: .8rem; color: var(--fg-muted); margin: 0 0 1rem; }

.version-switcher { display: flex; flex-wrap: wrap; gap: .35rem; margin-bottom: 1rem; }
.version-pill {
  font-size: .72rem;
  padding: .15rem .55rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  background: var(--bg);
}
.version-pill:hover { background: var(--accent-soft); text-decoration: none; }
.version-pill.version-current { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.version-pill.all-versions { color: var(--accent); border-style: dashed; }

#filter {
  width: 100%;
  padding: .5rem .6rem;
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: .9rem;
}
.nav-group summary {
  cursor: pointer;
  font-weight: 600;
  font-size: .8rem;
  text-transform: uppercase;
  letter-spacing: .03em;
  color: var(--fg-muted);
  padding: .4rem 0;
}
.nav-group a {
  display: block;
  padding: .25rem .5rem .25rem 1rem;
  border-radius: 4px;
  color: var(--fg);
  font-size: .88rem;
}
.nav-group a.is-resource { font-weight: 600; color: var(--accent); }
.nav-group a:hover { background: var(--accent-soft); text-decoration: none; }
.nav-group a.hidden, .nav-group.hidden { display: none; }

#main {
  flex: 1;
  min-width: 0;
  padding: 2rem 3rem 6rem;
  max-width: 1100px;
}
#main > header { margin-bottom: 2rem; }
#main > header h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
#main > header p { color: var(--fg-muted); margin: 0; }

.entity {
  padding: 1.5rem 0;
  border-bottom: 1px solid var(--border);
  scroll-margin-top: 1rem;
}
.entity.is-resource { background: var(--resource-tint); margin: 0 -1.5rem; padding: 1.5rem; border-radius: 8px; border-bottom: none; }
.entity h2 { margin: 0 0 .5rem; font-size: 1.25rem; display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.badge {
  font-size: .7rem;
  font-weight: 500;
  color: var(--fg-muted);
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: .1rem .6rem;
}
.entity p { color: var(--fg-muted); line-height: 1.5; font-size: .92rem; }

table.fields, table.ops-table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: .88rem; }
table.fields th, table.ops-table th {
  text-align: left;
  font-size: .72rem;
  text-transform: uppercase;
  color: var(--fg-muted);
  border-bottom: 1px solid var(--border);
  padding: .4rem .6rem;
}
table.fields td, table.ops-table td {
  padding: .5rem .6rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
table.fields td.field-desc p { margin: 0 0 .5rem; color: var(--fg); }
table.fields td.field-desc p:last-child { margin-bottom: 0; }
.field-name code { background: var(--code-bg); padding: .1rem .35rem; border-radius: 4px; }
.required { color: #e03131; margin-left: .25rem; font-weight: 700; }
.type-link { background: var(--accent-soft); padding: .1rem .4rem; border-radius: 4px; }
.type-prim { color: var(--fg-muted); }

details.operations { margin-top: 1rem; }
details.operations summary { cursor: pointer; font-size: .85rem; font-weight: 600; color: var(--fg-muted); }
.verb { padding: .1rem .4rem; border-radius: 4px; font-weight: 700; font-size: .75rem; }
.verb-get { background: #e7f5ff; color: #1971c2; }
.verb-post { background: #ebfbee; color: #2b8a3e; }
.verb-put, .verb-patch { background: #fff9db; color: #e67700; }
.verb-delete { background: #fff0f0; color: #e03131; }
@media (prefers-color-scheme: dark) {
  .verb-get { background: #142a3d; color: #74c0fc; }
  .verb-post { background: #113322; color: #69db7c; }
  .verb-put, .verb-patch { background: #3d3211; color: #ffd43b; }
  .verb-delete { background: #3d1717; color: #ff8787; }
}
`;

const JS = `
const filterInput = document.getElementById('filter');
const groups = [...document.querySelectorAll('.nav-group')];
filterInput.addEventListener('input', () => {
  const q = filterInput.value.trim().toLowerCase();
  for (const group of groups) {
    let anyVisible = false;
    for (const link of group.querySelectorAll('a')) {
      const match = !q || link.dataset.name.includes(q);
      link.classList.toggle('hidden', !match);
      if (match) anyVisible = true;
    }
    group.classList.toggle('hidden', !anyVisible);
    // Auto-expand groups with a match while searching; collapse again once
    // the filter is cleared, back to the default closed state.
    group.open = q ? anyVisible : false;
  }
});
`;

function renderVersionPage(spec, version, allVersions) {
  const definitions = spec.definitions || {};
  const meta = buildMeta(definitions);
  const opsIndex = buildOperationsIndex(spec.paths);

  const groups = new Map();
  for (const m of meta.values()) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }

  const sortedMeta = [...meta.values()].sort((a, b) => a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind));
  const sections = sortedMeta.map((m) => renderSection(m, meta, opsIndex)).join('\n');
  const sidebar = renderSidebarGroups(groups);
  const switcher = renderVersionSwitcher(version, allVersions);
  const totalKinds = [...meta.values()].filter((m) => m.isResource).length;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Kubernetes API Reference ${escapeHtml(version)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style>
</head>
<body>
<nav id="sidebar">
  ${switcher}
  <h1>Kubernetes API</h1>
  <p class="subtitle">${escapeHtml(version)} - ${meta.size} types, ${totalKinds} resources</p>
  <input id="filter" type="text" placeholder="Filter types...">
  ${sidebar}
</nav>
<main id="main">
  <header>
    <h1>Kubernetes API Reference</h1>
    <p>Generated from the upstream OpenAPI spec for ${escapeHtml(version)}.</p>
  </header>
  ${sections}
</main>
<script>${JS}</script>
</body>
</html>`;

  return {html, typeCount: meta.size, resourceCount: totalKinds};
}

function renderLandingPage(versions) {
  const items = versions.map((v, i) => `<li><a href="${escapeHtml(v)}/index.html">${escapeHtml(v)}</a>${i === 0 ? ' <span class="badge">latest</span>' : ''}</li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Kubernetes API Reference</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1d23; --fg-muted: #5b6270; --border: #e2e5ea;
  --accent: #3b5bdb; --accent-soft: #eef1fd; --code-bg: #f0f1f4;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14161a; --fg: #e6e8eb; --fg-muted: #9aa1ac; --border: #2b2f37; --accent: #7a9bff; --accent-soft: #1f2740; --code-bg: #20242c; }
}
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 480px; padding: 2rem; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
p { color: var(--fg-muted); }
ul.version-list { list-style: none; padding: 0; margin: 1.5rem 0 0; display: flex; flex-direction: column; gap: .5rem; }
ul.version-list li { border: 1px solid var(--border); border-radius: 8px; padding: .75rem 1rem; display: flex; align-items: center; justify-content: space-between; }
ul.version-list a { color: var(--accent); text-decoration: none; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
ul.version-list a:hover { text-decoration: underline; }
.badge { font-size: .7rem; font-weight: 500; color: var(--fg-muted); background: var(--code-bg); border: 1px solid var(--border); border-radius: 999px; padding: .1rem .6rem; }
</style>
</head>
<body>
<main>
  <h1>Kubernetes API Reference</h1>
  <p>Pick a version to browse.</p>
  <ul class="version-list">${items}</ul>
</main>
</body>
</html>`;
}

async function main() {
  const versionDirs = await fs.readdir(SPECS_DIR, {withFileTypes: true});
  const versions = versionDirs.filter((d) => d.isDirectory()).map((d) => d.name).sort(compareVersionsDesc);
  if (versions.length === 0) throw new Error(`No version directories found under ${SPECS_DIR}`);

  await fs.mkdir(OUT_DIR, {recursive: true});

  for (const version of versions) {
    const raw = await fs.readFile(path.join(SPECS_DIR, version, 'swagger.json'), 'utf8');
    const spec = JSON.parse(raw);
    const {html, typeCount, resourceCount} = renderVersionPage(spec, version, versions);

    const versionDir = path.join(OUT_DIR, version);
    await fs.mkdir(versionDir, {recursive: true});
    const outFile = path.join(versionDir, 'index.html');
    await fs.writeFile(outFile, html);
    console.log(`${version}: wrote ${outFile} (${(html.length / 1024 / 1024).toFixed(1)} MB, ${typeCount} types, ${resourceCount} resources)`);
  }

  await fs.writeFile(path.join(OUT_DIR, 'index.html'), renderLandingPage(versions));
  console.log(`Wrote ${path.join(OUT_DIR, 'index.html')} (landing page, ${versions.length} version(s))`);

  // GitHub Pages needs a CNAME file in *every* deploy when publishing via a
  // custom Actions workflow (as opposed to its own branch-based build) -
  // otherwise it silently drops the custom domain association on the next
  // deploy, even if it was working before. Since this whole build/ directory
  // is regenerated from scratch each run, this has to be rewritten every time.
  if (process.env.CUSTOM_DOMAIN) {
    await fs.writeFile(path.join(OUT_DIR, 'CNAME'), process.env.CUSTOM_DOMAIN.trim() + '\n');
    console.log(`Wrote ${path.join(OUT_DIR, 'CNAME')} (${process.env.CUSTOM_DOMAIN.trim()})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
