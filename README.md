# archipelago-discord-bridge

A Node.js Discord app that bridges Discord roles to
[Archipelago](https://archipelago.gg) multiworld hosting.

It receives slash-command interactions over the **Discord gateway** (default,
`DISCORD_GATEWAY=true`): the app declares a bot user purely as a transport — it
identifies with the bot token, heartbeats, and handles `INTERACTION_CREATE`. It
never reads message content and needs no gateway intents (`DISCORD_INTENTS=0`),
and **no public URL / HTTPS inbound endpoint is required**. Alternatively it can
run in HTTP interactions-endpoint mode (`DISCORD_GATEWAY=false`), which does
require a public HTTPS URL configured in the dev portal.

Roles are assigned by Discord ID:

| Role | Who | Can do |
|---|---|---|
| **Owner** | Discord ID in `.env` (`DISCORD_OWNER_ID`) | Everything, plus `/role` to assign host roles |
| **Host** | Assigned by the owner via `/role add host @user` | `/setup-game`, `/upload-apworld`, `/generate`, `/start`, `/stop` |
| **Player** | Anyone who runs `/register` with their player yaml | `/join`/`/leave` games, `/hints` (if enabled), `/stats`, `/game-stats` |
| **Spectator** | Everyone (including players and hosts) | `/status`, `/stats`, `/game-stats`, `/players` |

## How it works

- The app connects to the Discord **gateway** with the bot token and receives
  `INTERACTION_CREATE` events (no intents needed, no public URL required). The
  initial reply goes to `POST /interactions/{id}/{token}/callback`; results are
  delivered via followup webhooks. In HTTP endpoint mode (`DISCORD_GATEWAY=false`)
  the same pipeline is driven by signed `POST /interactions` requests instead
  (Ed25519-verified with the app's public key).
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
   - Copy the **Application ID** and **Bot token**.
   - On the *Bot* page, click **Add Bot** to declare a bot user (this is what enables
     the gateway transport, so no public HTTPS interactions endpoint is needed).
     Copy the token; no privileged intents are required.
   - Under *Installation*, enable **both** *Guild Install* and *User Install*
     (`integration_types: [0, 1]`), so the app can be added to servers **and** to
     individual users. The app also tries to set this itself via
     `PATCH /applications/@me` at boot. With both enabled, users get the "Add App"
     option in their DM list / the app's profile to install it to their account.
   - Commands are registered for both installation types and all interaction
     contexts (guild channels, the app DM, and other DMs/group DMs for user
     installs) — globally, and additionally as guild commands in `DISCORD_GUILD_ID`
     (if set) so changes show up instantly in your server.
   - Add the app to your server with the `bot applications.commands` scopes (the bot
     user joins; the app only answers interactions and needs no channel permissions),
     and/or to your user with `applications.commands`.
   - If you instead run HTTP endpoint mode (`DISCORD_GATEWAY=false`), set
     *General Information → Interactions Endpoint URL* to a public HTTPS URL reaching
     this service (tunnel such as cloudflared for local runs, or a domain + TLS
     reverse proxy in prod) and provide `DISCORD_PUBLIC_KEY` for signature
     verification. With the bot user present and no endpoint URL set, Discord
     delivers interactions over the gateway instead. Note: if `DISCORD_GUILD_ID` is
     set, interactions are only accepted from that guild — user-install DMs (which
     have no guild) are then rejected too, so leave it unset if you want the app
     usable in DMs.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`,
   `DISCORD_PUBLIC_KEY`, `DISCORD_OWNER_ID` (your Discord user ID) and
   `AP_SERVER_HOST` (the public hostname players use to reach Archipelago servers).
3. Run with Docker:

   ```sh
   docker compose up -d --build
   ```

   The container **updates itself to the newest version on boot**: the entrypoint
   pulls the latest `main` of this repository before starting. Set `SELF_UPDATE=false`
   to disable, or override `REPO_URL`/`REPO_BRANCH` for a fork. Runtime data lives in
   `./data` (a volume), so updates never wipe games, uploads or role assignments.

   **Archipelago itself is not in this repo.** On boot the entrypoint clones
   [Archipelago](https://github.com/ArchipelagoMW/Archipelago) into
   `/opt/Archipelago` on first run and updates it to the newest version on every
   boot (`AP_UPDATE=false` keeps the existing copy; `AP_REPO_URL`/`AP_BRANCH`
   override the source). The image bakes in only Archipelago's *Python
   dependencies* (`docker/requirements-ap.txt`) in a venv at `/opt/ap-venv`.

## Commands

- `/help` — commands available to your role
- `/register` (attachment: your player `.yaml`) — register as a player
- `/unregister`, `/me`, `/join game:`, `/leave game:`, `/players [game:]`
- `/setup-game name: password:` — host: create a game session (discards previous player registrations/yamls — everyone must `/register` again)
- `/upload-apworld game: file:` — host: upload a `.apworld`
- `/generate game: [seed:]` — host: generate the multiworld
- `/start game: [port:]` — host: start the Archipelago server
- `/stop game:` — host: stop the server
- `/status [game:]` — everyone: session/server status
- `/stats [game:]` — everyone: checks per player (`found/total`, %, status, hint points)
- `/game-stats [game:]` — everyone: gamewide totals, hints, seed
- `/hints [game:]` — players: your own hints (disable with `HINTS_ENABLED=false`)
- `/role add|remove|list` — owner: manage host roles

Typical flow: owner runs `/role add host @someone` → host runs `/setup-game`
(this wipes previous players/yamls) → players `/register` + `/join` → host
`/upload-apworld` (optional) → host `/generate` → host `/start` → everyone watches
`/stats` and `/game-stats`, players check `/hints`.

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
`scripts/entrypoint.sh` + `Dockerfile` (self-updating container that also
clones/updates Archipelago at boot), `docker/requirements-ap.txt` (Archipelago's
Python dependencies).

Only two npm dependencies: `tweetnacl` (the same Ed25519 verification the
`discord-interactions` package wraps) and `yaml` (player yaml parsing). Everything
else — HTTP server, REST calls, interaction dispatch — is Node's standard library,
because an interactions-only app needs very little: verify one signature, parse
JSON, answer callbacks/followups, register commands. Full bot libraries like
discord.js are built around a gateway bot connection, which is exactly what this
app avoids.
