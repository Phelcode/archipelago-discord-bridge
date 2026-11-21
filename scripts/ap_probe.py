#!/usr/bin/env python3
"""Probe for a running Archipelago server.

Connects to the server websocket using the Archipelago wire protocol
(plain JSON packets) as a TextOnly client, once per player slot, and reports
checked/missing locations, client status, hint points, hints and received
items as JSON on stdout. Exits non-zero with a message on stderr on failure.

Two modes:
  one-shot (default): connect, collect, print, exit.
  --daemon: stay alive, read JSON request lines on stdin, write one JSON
    response line per request on stdout. Slot websockets stay open between
    requests, so the server only sees a join/leave notice when the daemon
    starts (or a socket drops), not on every poll.

Note: the server only sends ReceivedItems to clients whose items_handling
has bit 0b001 set, so item-collecting connections use items_handling=7.
"""

import argparse
import asyncio
import json
import sys
import uuid

import websockets


def version_dict(v: str) -> dict:
    parts = v.split(".")
    major = int(parts[0]) if len(parts) > 0 else 0
    minor = int(parts[1]) if len(parts) > 1 else 0
    build = int(parts[2]) if len(parts) > 2 else 0
    return {"class": "Version", "major": major, "minor": minor, "build": build}


async def recv_until(ws, wanted, timeout):
    """Read packets until all commands in `wanted` have been seen. Returns dict cmd -> packet."""
    found = {}
    async def _loop():
        while not all(cmd in found for cmd in wanted):
            raw = await ws.recv()
            for msg in json.loads(raw):
                cmd = msg.get("cmd")
                if cmd in wanted and cmd not in found:
                    found[cmd] = msg
                elif cmd == "ConnectionRefused":
                    raise RuntimeError(f"ConnectionRefused: {msg.get('errors')}")
                elif cmd == "InvalidPacket":
                    raise RuntimeError(f"InvalidPacket: {msg.get('text')}")
    await asyncio.wait_for(_loop(), timeout)
    return found


async def connect_slot(uri, password, version, name, game, timeout, want_items=False):
    ws = await websockets.connect(uri)
    try:
        room_raw = await asyncio.wait_for(ws.recv(), timeout)
        room = json.loads(room_raw)[0]
        await ws.send(json.dumps([{
            "cmd": "Connect",
            "password": password,
            "name": name,
            "game": game,
            "version": version,
            "tags": ["AP", "TextOnly"],
            "items_handling": 7 if want_items else 0,
            "uuid": str(uuid.uuid4()),
            "slot_data": False,
        }]))
        msgs = await recv_until(ws, {"Connected"}, timeout)
        conn = msgs["Connected"]
        if want_items:
            # The server sends ReceivedItems on Connect/Sync only when the slot
            # has items and items_handling allows it; a short timeout means "none".
            conn["_received_items"] = []
            await ws.send(json.dumps([{"cmd": "Sync"}]))
            try:
                items_msgs = await recv_until(ws, {"ReceivedItems"}, min(timeout, 5.0))
                conn["_received_items"] = items_msgs["ReceivedItems"].get("items", [])
            except (asyncio.TimeoutError, TimeoutError):
                pass
        return ws, room, conn
    except Exception:
        await ws.close()
        raise


class SlotConns:
    """Persistent per-slot websocket connections for one server."""

    def __init__(self, uri, password, version, timeout):
        self.uri = uri
        self.password = password
        self.version = version
        self.timeout = timeout
        self.conns = {}  # slot name -> (ws, conn)
        self.room = None
        self.slot_info = None

    async def get(self, name, want_items):
        if name in self.conns:
            return self.conns[name]
        ws, room, conn = await connect_slot(self.uri, self.password, self.version, name, "", self.timeout, want_items)
        if self.room is None:
            self.room = room
            self.slot_info = {int(k): v for k, v in conn["slot_info"].items()}
        self.conns[name] = (ws, conn)
        return ws, conn

    async def drop(self, name):
        entry = self.conns.pop(name, None)
        if entry:
            try:
                await entry[0].close()
            except Exception:
                pass

    async def close_all(self):
        for name in list(self.conns):
            await self.drop(name)


async def run_overview(sc: SlotConns, timeout, known_slots, only, player_slots):
    """Single-connection monitor: room info plus every slot's hints and client
    status (datastorage Get keys are globally readable). Per-slot check counts
    are NOT available this way — those need one connection per slot."""
    own_name = known_slots[0] if known_slots else next(iter(player_slots.values()))["name"]
    if only:
        own_name = next(iter(only))
    ws, conn = await sc.get(own_name, False)
    games = sc.room.get("games", [])
    keys = []
    for slot in player_slots:
        keys += [f"_read_hints_0_{slot}", f"_read_client_status_0_{slot}"]
    await ws.send(json.dumps([{"cmd": "GetDataPackage", "games": games}]))
    await ws.send(json.dumps([{"cmd": "Get", "keys": keys}]))
    got = await recv_until(ws, {"DataPackage", "Retrieved"}, timeout)
    package = got["DataPackage"]["data"]["games"]
    retrieved = got["Retrieved"]["keys"]
    own_slot = conn.get("slot")
    results = {}
    for slot, info in sorted(player_slots.items()):
        results[slot] = {
            "slot": slot,
            "name": info.get("name", str(slot)),
            "game": info.get("game", ""),
            "checked": conn.get("checked_locations", []) if slot == own_slot else [],
            "missing": conn.get("missing_locations", []) if slot == own_slot else [],
            "hint_points": conn.get("hint_points", 0) if slot == own_slot else None,
            "status": retrieved.get(f"_read_client_status_0_{slot}", 0),
            "hints": retrieved.get(f"_read_hints_0_{slot}", []),
            "received": [],
        }
    return build_output(sc, games, results, "overview", None, package)


async def run_probe(sc: SlotConns, mode, want_slot, timeout, only=None, known_slots=()):
    if sc.room is None:
        # need at least one connection to learn the room/slot layout
        first = next(iter(only)) if only else (known_slots[0] if known_slots else None)
        if first is None:
            raise RuntimeError("no known slot names supplied (--slots)")
        await sc.get(first, mode == "received")
    if sc.slot_info is None:
        raise RuntimeError("server reports no slot info")
    player_slots = {s: info for s, info in sc.slot_info.items() if info.get("type") == 1}
    if only:
        # Connecting as a slot makes the server broadcast join/leave notices,
        # so limit connections to the requested slots.
        player_slots = {s: info for s, info in player_slots.items() if info.get("name") in only}
    if not player_slots:
        raise RuntimeError("server reports no player slots")

    if mode == "overview":
        return await run_overview(sc, timeout, known_slots, only, player_slots)

    games = sc.room.get("games", [])
    results = {}
    package = None
    for slot, info in sorted(player_slots.items()):
        name = info.get("name", str(slot))
        try:
            ws, conn = await sc.get(name, mode == "received")
            await ws.send(json.dumps([{"cmd": "GetDataPackage", "games": games}]))
            await ws.send(json.dumps([{"cmd": "Get", "keys": [
                f"_read_hints_0_{slot}", f"_read_client_status_0_{slot}"
            ]}]))
            if mode == "received":
                await ws.send(json.dumps([{"cmd": "Sync"}]))
            wanted = {"DataPackage", "Retrieved"} | ({"ReceivedItems"} if mode == "received" else set())
            got = await recv_until(ws, wanted, timeout if mode != "received" else min(timeout, 5.0))
            if mode == "received" and "ReceivedItems" not in got:
                conn["_received_items"] = []
            elif mode == "received":
                conn["_received_items"] = got["ReceivedItems"].get("items", [])
            if package is None:
                package = got["DataPackage"]["data"]["games"]
            retrieved = got["Retrieved"]["keys"]
            results[slot] = {
                "slot": slot,
                "name": name,
                "game": info.get("game", ""),
                "checked": conn.get("checked_locations", []),
                "missing": conn.get("missing_locations", []),
                "hint_points": conn.get("hint_points", 0),
                "status": retrieved.get(f"_read_client_status_0_{slot}", 0),
                "hints": retrieved.get(f"_read_hints_0_{slot}", []),
                "received": conn.get("_received_items", []),
            }
        except Exception:
            await sc.drop(name)  # reconnect fresh next time
            raise

    return build_output(sc, games, results, mode, want_slot, package)


def build_output(sc, games, results, mode, want_slot, package):
    def loc_name(game, loc_id):
        game_pkg = (package or {}).get(game, {})
        names = game_pkg.get("location_name_to_id", {})
        for name, lid in names.items():
            if lid == loc_id:
                return name
        return str(loc_id)

    def item_name(game, item_id):
        game_pkg = (package or {}).get(game, {})
        names = game_pkg.get("item_name_to_id", {})
        for name, iid in names.items():
            if iid == item_id:
                return name
        return str(item_id)

    slot_names = {s: r["name"] for s, r in results.items()}
    out = {
        "room": {
            "seed_name": sc.room.get("seed_name"),
            "games": games,
            "hint_cost": sc.room.get("hint_cost"),
            "location_check_points": sc.room.get("location_check_points"),
            "version": sc.room.get("version"),
            "password_required": bool(sc.room.get("password")),
        },
        "players": [],
        "hints": {},
    }
    for slot, r in sorted(results.items()):
        game = r["game"]
        out["players"].append({
            "slot": slot,
            "name": r["name"],
            "game": game,
            "checked": r["checked"],
            "checked_names": [loc_name(game, l) for l in r["checked"]],
            "missing_count": len(r["missing"]),
            "total": len(r["checked"]) + len(r["missing"]),
            "hint_points": r["hint_points"],
            "status": r["status"],
        })
        out["hints"][slot] = [{
            "receiving_player": h.get("receiving_player"),
            "finding_player": h.get("finding_player"),
            "finding_player_name": slot_names.get(h.get("finding_player"), str(h.get("finding_player"))),
            "location": loc_name(game, h.get("location")),
            "location_id": h.get("location"),
            "item": item_name(game, h.get("item")),
            "item_id": h.get("item"),
            "found": bool(h.get("found")),
            "status": h.get("status"),
            "entrance": h.get("entrance", ""),
        } for h in r["hints"]]
        out.setdefault("received", {})[slot] = [{
            "item_id": it.get("item"),
            "item": item_name(game, it.get("item")),
            "location_id": it.get("location"),
            "location": loc_name(game, it.get("location")),
            "sender_slot": it.get("player"),
            "sender_name": slot_names.get(it.get("player"), str(it.get("player"))),
            "flags": it.get("flags", 0),
        } for it in r["received"]]
    if mode == "hints":
        if want_slot is None:
            raise RuntimeError("--slot is required in hints mode")
        out["hints"] = {want_slot: out["hints"].get(want_slot, [])}
    if mode != "received":
        out.pop("received", None)
    return out


async def daemon(sc: SlotConns, timeout, known_slots):
    # Connect lazily on the first request (run_probe does that), so the
    # daemon can start before/without the game server and just answer errors.
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        try:
            req = json.loads(line)
            out = await run_probe(sc, req.get("mode", "stats"), req.get("slot"), timeout,
                                  only=set(req["only"]) if req.get("only") else None,
                                  known_slots=known_slots)
        except Exception as exc:
            out = {"error": str(exc)}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()
    await sc.close_all()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--password", default=None)
    parser.add_argument("--slots", default="", help="comma-separated known slot names")
    parser.add_argument("--mode", choices=["stats", "hints", "received", "overview"], default="stats")
    parser.add_argument("--slot", type=int, default=None)
    parser.add_argument("--only", default="", help="comma-separated slot names to connect as (others are skipped)")
    parser.add_argument("--ap-version", default="0.6.9")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--daemon", action="store_true", help="stay connected; serve JSON requests on stdin")
    args = parser.parse_args()

    uri = f"ws://{args.host}:{args.port}"
    known_slots = [s for s in args.slots.split(",") if s]
    only = {s for s in args.only.split(",") if s} or None
    version = version_dict(args.ap_version)
    sc = SlotConns(uri, args.password, version, args.timeout)
    try:
        if args.daemon:
            if not known_slots and not only:
                raise RuntimeError("no known slot names supplied (--slots)")
            asyncio.run(daemon(sc, args.timeout, known_slots))
        else:
            result = asyncio.run(run_probe(sc, args.mode, args.slot, args.timeout, only=only, known_slots=known_slots))
            json.dump(result, sys.stdout)
    except Exception as exc:
        print(f"probe failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        asyncio.run(sc.close_all())


if __name__ == "__main__":
    main()
