# 🌼 Petal Arena

A free-for-all multiplayer browser game where you play as a flower. Petals orbit your flower and act as your weapons. Kill mobs, collect their petal drops, build your loadout and fight other flowers.

Inspired by the gameplay of the early "static" version of florr.io. This is an independent fan project: all art and code are original, and it is not affiliated with or endorsed by the creators of florr.io.

---

## Quick start

**Requirements:** [Node.js](https://nodejs.org) (LTS version).

### Easiest: double-click
- **Windows:** open the folder and double-click `start-windows.bat`
- **Mac:** right-click `start-mac.command` → **Open** the first time, then double-click it after that

The starter installs anything missing, launches the server and opens the game in your browser.

### From a terminal
```bash
npm install     # first time only
npm start
```
Then open **http://localhost:3000**.

### Playing with friends on the same wifi
When the server starts it prints a **Friends** address, for example:
```
Friends:  http://192.168.1.23:3000   (same wifi)
```
Anyone on the same network can open that address in their browser and join your world. They don't need to install anything.

To stop the server, press **Ctrl + C** in the terminal (or close the starter window).

---

## Controls

| Action | Mouse | Keyboard |
|---|---|---|
| Move | Point where you want to go | WASD / arrow keys |
| Attack (petals spread out) | Hold left click | Hold Space |
| Defend (petals pull in) | Hold right click | Hold Shift |
| Select a bench petal | | Q / E (wraps around) |
| Swap a loadout slot | Click or drag petals | 1–8 |
| Delete selected petal | Drag to the red Delete slot | T |
| Swap the whole loadout with the bench | | X |
| Stand still while managing petals | Hover the bar at the bottom of the screen | |

Quick-delete combos: `Q T T T` deletes three bench petals in a row, and `3 T` sends loadout slot 3 to the bench and deletes it.

---

## Gameplay

- **Zones:** Easy → Medium → Hard → ?, from left to right. Mobs get tougher and drops get rarer as you go. You spawn in the zone that fits your level.
- **Overleveled:** at level 15 / 30 / 45 you're too high for Easy / Medium / Hard. A 45-second timer starts; when it fills, all your petals die. Move to a higher zone and they come back after 2.5 seconds.
- **Leveling:** XP comes from kills and from deleting petals, at the original rate. The XP needed per level matches the original (level 60 ≈ 22.4k points). You get an extra petal slot at levels 15, 30 and 45.
- **The curse:** from level 60, every mob on your screen comes after you.
- **Death:** your 3 best petals drop on the ground. You come back at ¾ of your level with up to 8 petals from your run (each remaining petal has a 10% chance to be lost). The home screen shows what you'll respawn with.
- **Spawn protection:** for 5 seconds after spawning, mobs ignore you (until you touch one).
- **Custom start:** the title screen's *Custom start* button lets you pick a level, zone and petals. Press Save and it's used for your next spawn (also after dying); the title screen shows what you'll spawn with.
- **Rarities:** Common, Unusual, Rare, Epic, Legendary, Unique.

The title screen has **Mobs** and **Petals** tabs listing everything currently in the game, including drop chances.

### Mobs
| Zone | Mobs |
|---|---|
| Easy | Ladybug, Bee, Rock, Boulder, Baby Ant, Worker Ant (right half), Centipede, Massive Ladybug (rare) |
| Medium | Ladybug, Bee, Cactus, Baby/Worker/Soldier Ants, Centipede, Yellow Ladybug; Beetle, Ant Hole and Massive Beetle in the right half |
| Hard | Spider, Hornet (right half), Beetle, Boulder, Ladybug and Soldier Ant (left half), Baby/Worker Ants, Centipede, Ant Hole, Massive Beetle, Evil Centipede |
| ? | Dark Ladybug, Spider, Hornet, Beetle, Boulder (left half), ants, Centipede, Ant Hole, Massive Beetle, Evil Centipede (right half) |

Ant Holes release 5 Baby, 8 Worker and 25 Soldier Ants as they take damage, plus a Queen Ant at low health.

### Petal abilities
Poison (Iris, Peas), healing (Rose, Leaf), projectiles (Peas, Missile, Dandelion, Web), Pollen ground traps, Yin Yang (reverses your petals' spin), Bubble launch, Wing swing, Honey slow, Salt damage reflect, Faster spin, Cactus max health, Egg pets, Web slow zones, Antennae extra vision, and multi-petals (Twin, Triplet, Pollen).

---

## Making it your own

Most of the game is plain JSON in the `config/` folder, so you can change it without touching code. Restart the server after editing.

| File | What's in it |
|---|---|
| `config/settings.json` | Flower speed and health, map and zone sizes, XP multiplier, petal orbit, mob behavior, drop timers, zoom |
| `config/mobs.json` | Every mob: health, damage, XP, size, speed, aggro range, chase speed, which zones it spawns in (min–max counts) and its drop table |
| `config/petals.json` | Every petal: rarity, damage, health, reload, color and special ability |

**Example: add a custom petal.** Add an entry to `petals.json`:
```json
"thorn": {
  "name": "Thorn", "rarity": "rare", "damage": 25, "health": 12, "reload": 2,
  "radius": 9, "trashXp": 50, "color": "#3a7d44", "outline": "#2a5c32", "shape": "triangle"
}
```
Then make a mob drop it, for example in `mobs.json` under `"bee"` → `"drops"`, add `"thorn": 0.05` for a 5% chance. It also appears automatically in the title-screen Petals tab.

**Example: make bees tougher.** In `mobs.json`, change the bee's `"health": 15` to `"health": 40`.

---

## Project structure

```
flower-game/
├── server.js            # Game server: world simulation, mobs, combat, multiplayer
├── public/
│   ├── index.html       # Title screen, custom start menu
│   ├── client.js        # Rendering, animation, controls, inventory UI
│   └── fonts/           # Ubuntu Bold (petal and level-bar lettering)
├── config/
│   ├── settings.json
│   ├── mobs.json
│   └── petals.json
├── start-windows.bat    # Double-click starter (Windows)
├── start-mac.command    # Double-click starter (Mac)
└── package.json
```

**How it works:** the Node.js server runs the whole game, simulating movement, petals, mobs and damage 25 times per second. It sends each player what's near them over a WebSocket. Browsers only draw the world and send input, which keeps every player in sync and the game fair.

---

## Roadmap

- [x] Easy, Medium and Hard zones
- [x] "?" zone (Dark Ladybug, Yin Yang)
- [ ] Saved progress between sessions
- [ ] Bots
- [ ] Online hosting so friends can join from anywhere

---

## License

Personal fan project, shared for friends to play and tinker with.
