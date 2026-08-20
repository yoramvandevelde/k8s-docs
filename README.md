# Kubernetes API reference (auto-updating)

A single-page, cross-linked API reference for the Kubernetes OpenAPI spec -
one HTML file per version, every type on it as its own anchored section, and
every field that references another type rendered as a same-page link to it.
That's the point: click `Deployment` -> `spec` -> `template` -> `spec` ->
`containers` -> `securityContext` and the page jumps straight there each
time, no reloads, no hunting through a sidebar tree of thousands of separate
pages.

This intentionally does **not** use a generic OpenAPI doc generator (tried
Docusaurus + `docusaurus-plugin-openapi-docs` first) - those render one
isolated page per *operation*, with the request/response schema fully
inlined and duplicated on every page and no linking between types at all.
Fine for a small REST API, unworkable for something the size of the full
Kubernetes API surface (~4 MB of spec, ~250 API kinds, several thousand
operations).

Multiple Kubernetes versions can be built side by side (e.g. 1.34, 1.35,
1.36) - each is fully independent, with its own anchors and sidebar computed
only from that version's spec. A small version switcher links between them
and back to a landing page, but every page still works as a standalone file
on its own.

A scheduled GitHub Action checks daily for new releases of the tracked
version(s) and, when one changed, rebuilds and redeploys the pages to
GitHub Pages automatically.

## How it fits together

```
scripts/fetch-specs.mjs    -> downloads the combined api/openapi-spec/swagger.json
                               for one or more k8s versions into
                               ./specs/<version>/swagger.json (gitignored,
                               rebuilt every run)
scripts/gen-reference.mjs  -> reads every ./specs/<version>/swagger.json,
                               resolves every $ref into a same-page anchor
                               link, and writes one self-contained
                               ./build/<version>/index.html per version, plus
                               a ./build/index.html landing page listing them
.github/workflows/...      -> runs both scripts on a schedule and pushes
                               ./build to GitHub Pages
```

No framework, no bundler, no `node_modules` at runtime - `gen-reference.mjs`
uses only Node's built-in `fs`, and the output is plain HTML/CSS with a
handful of lines of vanilla JS for the sidebar filter box.

## One-time setup

1. Push this to a GitHub repo.
2. Repo Settings -> Pages -> Source: **GitHub Actions**.
3. (Optional) Repo Settings -> Secrets and variables -> Actions -> Variables
   -> new repo variable `K8S_VERSIONS` to pick which versions to track (see
   below). Without it, only the single latest stable release is built.
4. Push to `main` (or run the workflow manually via Actions -> "Build & deploy
   Kubernetes API docs" -> Run workflow) to trigger the first build.

From then on it runs itself: a daily check for new releases of the tracked
version(s), and a rebuild + redeploy only when something actually changed.

There's no `baseUrl`/subpath configuration needed - every page is a single
flat `index.html` with no absolute-path assets, so it works the same whether
it's served at a domain root or under `https://<org>.github.io/<repo>/`.

## Local development

Single version (defaults to latest stable):

```bash
npm run fetch-specs   # downloads specs/<version>/swagger.json
npm run build          # writes build/<version>/index.html + build/index.html
open build/index.html  # or: npm run serve, then open http://localhost:3000
```

Since each page is a single self-contained file with no relative fetches or
routing, opening it directly via `file://` works fine - no server required.

Multiple versions, independent of each other:

```bash
K8S_VERSIONS="1.34,1.35,1.36" npm run fetch-specs
npm run build
```

Each entry in `K8S_VERSIONS` is either a minor version ("1.34" - resolved to
its latest patch via `dl.k8s.io/release/stable-1.34.txt`) or a full version
("v1.34.10" - used as-is), so you can pin exact patches for some and float
others. `K8S_VERSION` (singular) still works for the single-version case if
you want to pin one exact release without touching `K8S_VERSIONS`.

## Tracking your own spec instead

This pipeline is wired to the Kubernetes upstream repo specifically. To
track a different (e.g. your own) OpenAPI spec instead:

- Replace `scripts/fetch-specs.mjs`'s download logic with whatever fetches
  your spec (a URL, an artifact from another repo, a file already in this
  repo, etc.), writing it to `specs/<version>/swagger.json`.
- `gen-reference.mjs` expects Swagger 2.0 shape (`definitions` map with
  `$ref: '#/definitions/...'` pointers) - if your spec is OpenAPI 3
  (`components.schemas`, `$ref: '#/components/schemas/...'`), adjust the
  spec parsing accordingly (or convert first with something like
  [`api-spec-converter`](https://www.npmjs.com/package/api-spec-converter)).
- The `x-kubernetes-group-version-kind` / `x-kubernetes-action` extensions
  used to detect "top-level resource" types and their available operations
  are Kubernetes-specific conventions, not part of OpenAPI/Swagger itself -
  without them every definition is just treated as a plain nested type
  (still fully cross-linked, just without the "Operations" table and the
  visual resource/sub-type distinction in the sidebar).
- Swap the version resolution in `fetch-specs.mjs` (currently
  `dl.k8s.io/release/stable.txt` and `dl.k8s.io/release/stable-<minor>.txt`)
  for whatever signals "the source spec changed" for you - a git SHA, an
  ETag, a release tag, etc.
