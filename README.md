# archipelago-discord-bridge

A Node.js **Discord app** (interactions endpoint — *not* a bot: it never connects to the
Discord gateway and never reads messages) that bridges Discord roles to
[Archipelago](https://archipelago.gg) multiworld hosting.

Roles are assigned by Discord ID:

| Role | Who | Can do |
|---|---|---|
| **Owner** | Discord ID in `.env` (`DISCORD_OWNER_ID`) | Everything, plus `/role` to assign host roles |
| **Host** | Assigned by the owner via `/role add host @user` | `/setup-game`, `/upload-apworld`, `/generate`, `/start`, `/stop` |
| **Player** | Anyone who runs `/register` with their player yaml | `/join`/`/leave` games, `/hints` (if enabled), `/stats`, `/game-stats` |
| **Spectator** | Everyone (including players and hosts) | `/status`, `/stats`, `/game-stats`, `/players` |

## How it works

- Discord sends slash-command interactions to `POST /interactions` on this app.
  Requests are verified with the app's Ed25519 public key; the app replies via the
  interaction callback and followup webhooks (no bot token needed for replies; the
  token is only used to register the slash commands at boot).
- Hosts upload `.apworld` files and players upload player `.yaml` files as Discord
  attachments; they are validated and stored under `DATA_DIR`.
- `/generate` runs Archipelago's `Generate.py` with the game's player yamls and
  custom apworlds, producing a `.archipelago` multidata archive.
- `/start` launches `MultiServer.py` for that archive; `/stats`, `/game-stats` and
  `/hints` query the running server over its websocket protocol as a spectator
  (`scripts/ap_probe.py`) and report checks per player, completion status, hint
  points, gamewide totals and hints.

## Setup

1. Create an application at <https://discord.com/developers/applications>.
   - Copy the **Application ID**, **Public Key**, and a **Bot token** (the token is
     only used for REST calls like registering commands — the app is added with the
     `applications.commands` scope only, no bot/gateway scopes).
   - Under *General Information → Interactions Endpoint URL*, set the public HTTPS
     URL of this service, e.g. `https://bridge.example.com/interactions` (you need a
     tunnel such as cloudflared pointed at the container's port).
   - Add the app to your server with `applications.commands` scope.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`,
   `DISCORD_PUBLIC_KEY`, `DISCORD_OWNER_ID` (your Discord user ID) and
   `AP_SERVER_HOST` (the public hostname players use to reach Archipelago servers).
3. Run with Docker:

   ```sh
   docker compose up -d --build
   ```

   The container **updates itself to the newest version on boot**: the entrypoint
   pulls the latest `main` of this repository (and of Archipelago) before starting.
   Set `SELF_UPDATE=false` / `AP_UPDATE=false` to disable, or override
   `REPO_URL`/`REPO_BRANCH` for a fork. Runtime data lives in `./data` (a volume), so
   updates never wipe games, uploads or role assignments.

## Commands

- `/help` — commands available to your role
- `/register` (attachment: your player `.yaml`) — register as a player
- `/unregister`, `/me`, `/join game:`, `/leave game:`, `/players [game:]`
- `/setup-game name: password:` — host: create a game session
- `/upload-apworld game: file:` — host: upload a `.apworld`
- `/generate game: [seed:]` — host: generate the multiworld
- `/start game: [port:]` — host: start the Archipelago server
- `/stop game:` — host: stop the server
- `/status [game:]` — everyone: session/server status
- `/stats [game:]` — everyone: checks per player (`found/total`, %, status, hint points)
- `/game-stats [game:]` — everyone: gamewide totals, hints, seed
- `/hints [game:]` — players: your own hints (disable with `HINTS_ENABLED=false`)
- `/role add|remove|list` — owner: manage host roles

Typical flow: owner runs `/role add host @someone` → host runs `/setup-game` →
players `/register` + `/join` → host `/upload-apworld` (optional) → host
`/generate` → host `/start` → everyone watches `/stats` and `/game-stats`, players
check `/hints`.

## Configuration (`.env`)

See [.env.example](.env.example) for all variables: Discord credentials, owner ID,
optional guild restriction (`DISCORD_GUILD_ID`), ports, `HINTS_ENABLED`,
self-update settings, and Archipelago source settings.

## Development

```sh
npm install
npm test          # unit + HTTP interaction tests (no Discord/AP needed)
npm start         # requires the env vars; AP_DIR/AP_PYTHON point at an
                  # Archipelago checkout + venv for /generate, /start, /stats
```

Layout: `src/index.js` (HTTP interactions server), `src/discord/` (signature
verification, REST API, permissions, command handlers), `src/ap/manager.js`
(Archipelago process management), `scripts/ap_probe.py` (spectator probe),
`scripts/entrypoint.sh` + `Dockerfile` (self-updating container).
