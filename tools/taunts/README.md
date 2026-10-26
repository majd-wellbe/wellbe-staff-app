# Taunt converter (Mixamo to Corniche Run)

Turns Mixamo moves into the small clip files the game plays at the start line
(during the 3 2 1 countdown) and in the runner picker (Taunt tab).

Output: `client/models/taunts/<id>.json` (one per move) and `client/models/taunts/manifest.json`
(the list the game reads). The runner model is never changed.

## 1. Download from Mixamo

For each move on mixamo.com:

- Character: **Y Bot** (the default)
- Turn **In Place** on if the move has that box (it is safer, the converter also keeps the runner on the spot)
- Download settings: Format **FBX Binary (.fbx)**, Skin **Without Skin**, Frames per second **30**, Keyframe Reduction **none**
- Keep the file name Mixamo gives (for example `Jumping_Jacks.fbx`) and put all files in one folder

## 2. Add the move to `moves.json`

One line per move:

```json
{"file":"Jumping_Jacks.fbx","id":"jacks","name":"Jumping Jacks","loop":true,"place":"lock"}
```

- `id`: short, lower case, letters and numbers. The game id becomes `tn_<id>`.
- `name`: what players see.
- `loop`: true repeats the move during the countdown (good for exercises and dances); leave it out to play it once and then stand.
- `from` / `to`: seconds to keep (trim long moves to 2 to 4 s).
- `place`: `lock` removes all ground travel (rolls, spins, moves that walk away); `clamp` keeps a little sway (max 12 cm, `sway` to change it).
- `fps`: 24 by default.

## 3. Run it

Needs Node 18+ and three.js r128 (the version the game uses):

```
npm install three@0.128.0                # once, anywhere
node tools/taunts/convert.js --three node_modules/three --rig <a1.glb> --in <folder with the .fbx files>
```

`--rig` is the runner animation file `a1` (the `a1` link in `window.AVF` in `client/run.html`; download it once).
Add `--only jacks` to convert one move. Each file is 15 to 50 KB.

## 4. Price it and ship it

- `1-apps-script/phase3/Config.gs`, `game.studio`: add `tn_<id>: { n: 'Name', k: 'taunt', coins: 900 }` (add `lv: 5` to open it at a level first).
- `client/run.html`: add `['tn_<id>','Name']` to `TAUNTS` (the order of the Taunt tab) and an icon in `TAUNT_ICON` (optional; the manifest alone also adds it at the end).
- Copy `run.html` to `run-test.html`, upload `client/models/taunts/`, paste Config.gs in Apps Script.

## How it works

- Reads the FBX with three's FBXLoader (Mixamo's file as loaded is the T pose) and the runner skeleton from the GLB nodes.
- Bone names are mapped (`mixamorig:Hips` to `pelvis`, `LeftArm` to `upperarm_l`, ... see `MAP`). Fingers stay at rest.
- The runner's rest pose is first lined up with the T pose bone by bone (each bone swung to point where the Mixamo bone points),
  then every frame copies each Mixamo bone's world rotation change from its T pose onto the runner bone.
- Hips height is scaled to the runner; ground travel is removed or clamped; feet and hands are kept above the floor.
- A looping move eases its last 0.3 s into the first frame. Rotations are rounded to 3 decimals and bones that never move keep one key.
