#!/usr/bin/env python3
"""Spectator probe for a running Archipelago server.

Connects to the server websocket using the Archipelago wire protocol
(plain JSON packets) as a TextOnly client, once per player slot, and
reports checked/missing locations, client status, hint points and hints
as JSON on stdout. Exits non-zero with a message on stderr on failure.
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


async def connect_slot(uri, password, version, name, game, timeout):
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
            "items_handling": 0,
            "uuid": str(uuid.uuid4()),
            "slot_data": False,
        }]))
        msgs = await recv_until(ws, {"Connected"}, timeout)
        return ws, room, msgs["Connected"]
    except Exception:
        await ws.close()
        raise


async def probe(uri, password, version, known_slots, mode, want_slot, timeout):
    if not known_slots:
        raise RuntimeError("no known slot names supplied (--slots)")
    ws, room, conn = await connect_slot(uri, password, version, known_slots[0], "", timeout)
    try:
        slot_info = {int(k): v for k, v in conn["slot_info"].items()}
        player_slots = {s: info for s, info in slot_info.items() if info.get("type") == 1}
        if not player_slots:
            raise RuntimeError("server reports no player slots")

        games = room.get("games", [])
        results = {}
        package = None
        for slot, info in sorted(player_slots.items()):
            if slot == conn["slot"]:
                slot_ws, connected = ws, conn
            else:
                slot_ws, _, connected = await connect_slot(uri, password, version, info["name"], "", timeout)
            try:
                await slot_ws.send(json.dumps([{"cmd": "GetDataPackage", "games": games}]))
                await slot_ws.send(json.dumps([{"cmd": "Get", "keys": [
                    f"_read_hints_0_{slot}", f"_read_client_status_0_{slot}"
                ]}]))
                got = await recv_until(slot_ws, {"DataPackage", "Retrieved"}, timeout)
                if package is None:
                    package = got["DataPackage"]["data"]["games"]
                retrieved = got["Retrieved"]["keys"]
                results[slot] = {
                    "slot": slot,
                    "name": info.get("name", str(slot)),
                    "game": info.get("game", ""),
                    "checked": connected.get("checked_locations", []),
                    "missing": connected.get("missing_locations", []),
                    "hint_points": connected.get("hint_points", 0),
                    "status": retrieved.get(f"_read_client_status_0_{slot}", 0),
                    "hints": retrieved.get(f"_read_hints_0_{slot}", []),
                }
            finally:
                if slot_ws is not ws:
                    await slot_ws.close()
    finally:
        await ws.close()

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
            "seed_name": room.get("seed_name"),
            "games": games,
            "hint_cost": room.get("hint_cost"),
            "location_check_points": room.get("location_check_points"),
            "version": room.get("version"),
            "password_required": bool(room.get("password")),
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
    if mode == "hints":
        if want_slot is None:
            raise RuntimeError("--slot is required in hints mode")
        out["hints"] = {want_slot: out["hints"].get(want_slot, [])}
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--password", default=None)
    parser.add_argument("--slots", default="", help="comma-separated known slot names")
    parser.add_argument("--mode", choices=["stats", "hints"], default="stats")
    parser.add_argument("--slot", type=int, default=None)
    parser.add_argument("--ap-version", default="0.6.9")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    uri = f"ws://{args.host}:{args.port}"
    known_slots = [s for s in args.slots.split(",") if s]
    try:
        result = asyncio.run(probe(uri, args.password, version_dict(args.ap_version),
                                    known_slots, args.mode, args.slot, args.timeout))
    except Exception as exc:
        print(f"probe failed: {exc}", file=sys.stderr)
        sys.exit(1)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
