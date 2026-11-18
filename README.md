# archipelago-discord-bridge

A Node.js Discord app that bridges Discord roles to
[Archipelago](https://archipelago.gg) multiworld hosting.

It receives slash-command interactions over the **Discord gateway** via
[discord.js](https://discord.js.org) (a `Client` with no intents): the app
declares a bot user purely as a transport. Heartbeats, resume and sharding are
handled by the library, it never reads message content, and **no public URL /
HTTPS inbound endpoint is required**.

Roles are assigned by Discord ID:

| Role | Who | Can do |
|---|---|---|
| **Owner** | Discord ID in `.env` (`DISCORD_OWNER_ID`) | Everything, plus `/role` to assign host roles |
| **Host** | Assigned by the owner via `/role add host @user` | `/setup-game`, `/upload-apworld`, `/start`, `/stop`, `/delete-game` |
| **Player** | Anyone who runs `/register` with their player yaml | `/join`/`/leave` games, `/hints` (if enabled), `/stats`, `/game-stats` |
| **Spectator** | Everyone (including players and hosts) | `/status`, `/stats`, `/game-stats`, `/players` |

## How it works

- The app connects to the Discord **gateway** with the bot token via discord.js and
  handles `INTERACTION_CREATE` events (no intents needed, no public URL required).
  Replies are sent with the interaction's built-in `reply`/`deferReply`/`editReply`/
  `followUp` methods; file uploads from modals are downloaded from the attachment
  URLs Discord provides.
- Hosts upload `.apworld` files and players upload player `.yaml` files as Discord
  attachments; they are validated and stored under `DATA_DIR`. `.apworld` files are
  **global** — uploaded once, they are installed into every game at generation time.
- `/start` runs Archipelago's `Generate.py` first if the game hasn't been
  generated yet (seed from the `/setup-game` form, random if empty), producing a
  `.archipelago` multidata archive, then launches `MultiServer.py` for it;
  `/stats`, `/game-stats` and
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
   - Note: if `DISCORD_GUILD_ID` is set, interactions are only accepted from that
     guild — user-install DMs (which have no guild) are then rejected too, so leave
     it unset if you want the app usable in DMs.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`,
   `DISCORD_OWNER_ID` (your Discord user ID) and
   `AP_SERVER_HOST` (the public hostname players use to reach Archipelago servers).
3. Run with Docker:

   ```sh
   docker compose up -d --build
   ```

   The compose service sets `container_name: ap-manager`, so refer to the
   container by that name: `docker logs ap-manager`, `docker restart ap-manager`,
   etc. If you build/run without compose instead: `docker build -t ap-manager .`
   and `docker run --name ap-manager ...`.

   Ports: the compose file publishes `PORT` (3000, bridge `/health` only —
   interactions from Discord arrive over the gateway websocket, so this port does
   not need to be public) **and the Archipelago game port range**
   `BASE_PORT`..`AP_PORT_RANGE_END` (default 38281–38290), because each running
   game's Archipelago server listens on the next free port from `BASE_PORT` and
   players must reach it. Adjust the range in `docker-compose.yml` if you change
   `BASE_PORT`.

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
   The base image is `node:22-trixie-slim` (Debian 13, Python 3.13) because
   Archipelago requires Python 3.12–3.13 and rejects bookworm's Python 3.11.
   After pulling this change, **rebuild** the image (`docker compose up -d --build`) —
   the self-update only syncs app code, not the base image or the venv. The
   Dockerfile fails the build if the venv Python is outside 3.12–3.13, and the
   entrypoint logs a clear warning on boot if AP can't be imported.

## Commands

- `/help` — commands available to your role
- `/register` — register as a player (always opens a modal with a file-upload field for your player `.yaml` + optional slot-name field)
- `/unregister`, `/profile [responses:]`, `/join game:`, `/leave game:`, `/players [game:]`
  - `/profile` shows your role and registration; `/profile responses: private` makes **all** replies to your commands private (only you see them) — choice labels say "private — only I see the replies" / "public — everyone sees the replies (default)"
- `/setup-game` — host: create a game session (always opens a modal: name + optional password + optional seed, random if empty; discards previous player registrations/yamls — everyone must `/register` again)
- `/upload-apworld` — host: always opens a modal (`.apworld` file-upload field only; apworlds are global and usable in any game)
- `/start game: [port:]` — host: generate the multiworld if needed, then start the Archipelago server
- `/stop game:` — host: stop the server
- `/status [game:] [scope:]` — everyone: session/server status. Without `game:`, lists games — **active ones by default** (started or waiting to be started); `scope: finished` shows stopped games, `scope: all` shows everything. With `game:`, shows that one game regardless of scope
- `/delete-game game:` — host: stop the server if running, then delete the game session and its files
- `/stats [game:]` — everyone: checks per player (`found/total`, %, status, hint points)
- `/game-stats [game:]` — everyone: gamewide totals, hints, seed
- `/hints [game:]` — players: your own hints (disable with `HINTS_ENABLED=false`)
- `/role add|remove|list` — owner: manage host roles

Typical flow: owner runs `/role add host @someone` → host runs `/setup-game`
(this wipes previous players/yamls) → players `/register` + `/join` → host
`/upload-apworld` (optional) → host `/start` (generates the multiworld if needed,
then runs the server) → everyone watches `/stats` and `/game-stats`, players check `/hints`.

## Configuration (`.env`)

See [.env.example](.env.example) for all variables: Discord credentials, owner ID,
optional guild restriction (`DISCORD_GUILD_ID`), ports, `HINTS_ENABLED`,
self-update settings, and Archipelago source settings.

## Development / branch workflow

- `main` is the stable, released state. All work-in-progress lands on the **`dev`
  branch** (one branch, no per-fix branches).
- To test a WIP build with the self-updating container, point it at `dev` in
  `.env`: `REPO_BRANCH=dev` (the entrypoint pulls that branch on boot). Once
  `dev` is verified, merge it to `main` and set `REPO_BRANCH=main` (default).

## Development (local)

```sh
npm install
npm test          # unit + interaction dispatch tests (no Discord/AP needed)
npm start         # requires the env vars; AP_DIR/AP_PYTHON point at an
                  # Archipelago checkout + venv for /start, /stats
```

Layout: `src/index.js` (entrypoint: health server + discord.js client login and
command registration), `src/discord/` (discord.js client + interaction dispatch,
permissions, command handlers), `src/ap/manager.js`
(Archipelago process management), `scripts/ap_probe.py` (spectator probe),
`scripts/entrypoint.sh` + `Dockerfile` (self-updating container that also
clones/updates Archipelago at boot), `docker/requirements-ap.txt` (Archipelago's
Python dependencies).

Only two npm dependencies: `discord.js` (gateway connection, REST, interaction
handling — heartbeats, resume and reconnects included) and `yaml` (player yaml
parsing).
