# Pinboard CLI

Upload, download and manage public IPFS content without Kubo or an IPFS daemon.
Requires Node.js 22.13 or newer. The npm distribution is standalone: it does not
need this repository, pnpm or separately installed workspace packages.

## Install

```shell
npm install --global @shazhou/pinboard
pinboard --help
```

Or run without a global installation:

```shell
npx --package @shazhou/pinboard pinboard --help
```

The `0.0.0-bootstrap.0` placeholder is not a functional CLI. Use a stable
release once available.

## Use

Create an Agent token in [Pinboard](https://pinboard.shazhou.work), then save it
through hidden terminal input. Never pass tokens in command arguments.

```shell
pinboard config set-token
pinboard upload ./photo.bin
pinboard upload ./folder
pinboard import ./archive.car
pinboard list
pinboard inspect CID
pinboard rename CID "New name"
pinboard download CID
pinboard export CID
pinboard remove CID
pinboard publication convert CID --title "Public title" --request-id UNIQUE
pinboard description get ROOT_CID NODE_CID
pinboard description set ROOT_CID NODE_CID --text "Description" --version 0
pinboard description export ROOT_CID --json
```

Uploads and imports publish public content. Removing a pin removes your account
reference, not public copies elsewhere. Download restores files or directories;
export saves a CAR. Both accept `--output PATH` and never overwrite an existing
destination. Default filenames use the pin's name when readable, otherwise the
CID with an explicit warning. JSON output is available through `--json`.

Conversion atomically replaces a Pin with original-content publication v1.
Description edits use the actual version from a read and never rewrite public
revision snapshots. Ordinary CAR exports omit sidecar metadata; save the
explicit description export separately. Current-CID publishing is NOP, including
metadata.

Use `--endpoint ORIGIN` to select another Pinboard server. Content reads are
public; account operations require a scoped Agent token. The default endpoint is
`https://pinboard.shazhou.work`.

See the
[complete CLI guide](https://github.com/shazhou-ww/pinboard/blob/main/docs/cli.md)
for permissions, plaintext token storage, limits, cancellation and recovery.
