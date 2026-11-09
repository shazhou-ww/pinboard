# Tag-driven npm releases

The CLI package is `@shazhou/pinboard`; its executable is `pinboard`. Tags named
**`@shazhou/pinboard@x.y.z`** trigger CLI npm publication. For example,
`@shazhou/pinboard@0.1.0` publishes version `0.1.0`. Versions are stable numeric
SemVer triples without leading zeros. Other package names, prereleases, branch
pushes and manual dispatch do not publish. The reusable React background uses
the separate **`react-engraved-background@x.y.z`** tag family in the same
workflow. Each tag publishes only its named package.

This is independent of the Cloudflare application's `release-YYMMDD-INDEX` tags.
Publishing the CLI does not deploy the Worker, run D1 migrations or change
production configuration.

## One-time Trusted Publisher configuration

Configure the npm package's GitHub Actions trusted publisher with:

| Field             | Value              |
| ----------------- | ------------------ |
| GitHub owner      | `shazhou-ww`       |
| Repository        | `pinboard`         |
| Workflow filename | `publish-npm.yaml` |
| Environment       | `npm`              |

Permit direct `npm publish` if npm exposes a separate allowed-action setting.
The workflow uses a GitHub-hosted runner and job-scoped `id-token: write`. No
`NPM_TOKEN` or `NODE_AUTH_TOKEN` is configured or needed. npm publishing uses
Node.js 24.11.1 and its npm CLI with OIDC support, and includes provenance.

The GitHub `npm` Environment must allow tags matching `@shazhou/pinboard@*` and
`react-engraved-background@*`. Required reviewers and tag rulesets may restrict
who can release. Do not remove protections just to make a pending deployment
pass.

The initial `0.0.0-bootstrap.0` package is a placeholder for configuring trust,
not an installable CLI. Until the first stable release replaces `latest`,
installing `latest` may still select that placeholder.

## Build and validate without publishing

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm prepare:cli 0.1.0
pnpm --dir apps/cli/dist/npm pack --pack-destination ..
$env:PINBOARD_CLI_EXPECTED_VERSION = "0.1.0"
node --test .\scripts\cli-package.test.mjs
Remove-Item Env:\PINBOARD_CLI_EXPECTED_VERSION
```

`prepare:cli [x.y.z]` bundles the executable and all non-builtin runtime
dependencies, including the private contracts and encoding workspaces, and
prepares the release directory. Native `pnpm pack` creates the tarball; the
preparation script does not launch a package manager. The npm artifact contains
only:

- The executable, with a Node shebang.
- Package metadata and the CLI README.
- The project license and bundled third-party license notices.

There are no runtime npm dependencies, workspace/catalog references, lifecycle
scripts, source tests, credentials or development tooling in the package. The
root and workspace manifests remain private; only the generated release manifest
is publishable. Its version comes from the tag, not a source version bump.
Running `pnpm package:cli` prepares and packs a private `0.0.0-development.0`
package for smoke tests. To pack a release version locally, use the two commands
above; neither command publishes it.

The exact tarball is written to `apps/cli/dist/shazhou-pinboard-<version>.tgz`.
The isolated smoke test installs it offline through npm into a fresh directory
outside the checkout, with a fresh npm cache. At runtime PATH contains only a
copied Node executable: no pnpm, Kubo or checkout dependencies are available. It
exercises the installed command shim, help/config, directory upload, CAR
export/import, rename, download with the pin filename, list/inspect and remove
against a synthetic loopback HTTP fixture. This is distribution evidence, not
production authorization evidence.

`pnpm check` includes that distribution test. Existing CI runs it on
Windows/Ubuntu and both supported Node versions. The publish workflow repeats
the test against the exact release-version tarball before publishing that same
file.

## Publish a stable version

First commit the intended changes, synchronize them to `origin/main`, and wait
for supported-platform CI to pass. Then, only with explicit release
authorization:

```powershell
git tag -a "@shazhou/pinboard@0.1.0" -m "Publish @shazhou/pinboard 0.1.0"
git push origin "@shazhou/pinboard@0.1.0"
```

Use the intended unused version. The workflow validates the tag and checks that
the tagged commit is already on `origin/main`, installs the lockfile, runs
`pnpm check`, builds the tag's version, verifies its exact tarball, and
publishes it publicly under `latest` with provenance.

Afterward verify the npm version, `latest` dist-tag and provenance, and install
that exact version in a clean environment. A successful local pack or workflow
configuration alone is not evidence that Trusted Publishing has succeeded.
Published versions are immutable: fix forward with a new version instead of
moving/reusing a tag or attempting to overwrite a package.

## React engraved background releases

Configure `react-engraved-background` with the same trusted publisher fields
above. Its package version is supplied by the release tag; the development
manifest remains `0.0.0`. Preparing a release copies the compiled ESM modules,
TypeScript declarations, README, and license into a clean staging directory. The
published manifest retains React as a peer dependency and repository metadata,
but excludes development dependencies, scripts, and workspace/catalog
references. React and icon libraries are not bundled.

Validate an exact release locally without publishing:

```powershell
pnpm prepare:background 0.1.0
pnpm --dir packages/react-engraved-background/dist/npm pack --pack-destination ..
$env:BACKGROUND_EXPECTED_VERSION = "0.1.0"
node --test .\scripts\background-package.test.mjs
Remove-Item Env:\BACKGROUND_EXPECTED_VERSION
```

The smoke test installs the actual tarball offline outside the checkout,
supplies copied local React peer fixtures, and renders the installed component
in a separate process. It checks the release version, exported files,
deterministic layout, and seamless SVG wrapping. `pnpm check` includes this test
with version `0.0.0`; the workflow repeats it using the tag's release version.

After the intended commit is on `origin/main` and supported-platform CI has
passed, explicitly authorized publication uses:

```powershell
git tag -a "react-engraved-background@0.1.0" -m "Publish react-engraved-background 0.1.0"
git push origin "react-engraved-background@0.1.0"
```

The workflow validates main ancestry and publishes the tested
`packages/react-engraved-background/dist/react-engraved-background-0.1.0.tgz`
under `latest` with provenance. It does not publish the CLI or deploy
Cloudflare. Verify the resulting version, dist-tag, and provenance through
npmx.dev after the action succeeds.
