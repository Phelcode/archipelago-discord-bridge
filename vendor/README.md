# Vendored Archipelago

`Archipelago/` is a vendored source snapshot of
[ArchipelagoMW/Archipelago](https://github.com/ArchipelagoMW/Archipelago) at commit
`cf08efe5b1c132bf966ae810c007b8268d47b7b0` (version 0.6.9), with `.git`, `test/`,
`logs/`, `.github/` and `__pycache__` removed. The Docker image copies it to
`/opt/Archipelago` at build time, so the bridge runs the generator
(`Generate.py`) and server (`MultiServer.py`) without downloading anything at
runtime.

To refresh the snapshot:

```sh
git clone --depth 1 https://github.com/ArchipelagoMW/Archipelago.git /tmp/ap-src
cd /tmp/ap-src && tar --exclude='./.git' --exclude='./__pycache__' --exclude='./logs' \
  --exclude='./test' --exclude='./.github' -cf - . | tar -xf - -C /path/to/this/repo/vendor/Archipelago
git -C /tmp/ap-src rev-parse HEAD   # record the new commit above
```

Set `AP_UPDATE=true` in `.env` only if you want the container to additionally pull
the latest Archipelago from GitHub on boot instead of using this snapshot.
