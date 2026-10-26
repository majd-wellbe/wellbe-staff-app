# City scenery: licenses

`env_city.glb` is built from **Kenney** (www.kenney.nl) kits, released under **CC0 1.0 Universal** (public domain dedication):
https://creativecommons.org/publicdomain/zero/1.0/ . Free for commercial use, no attribution required. Credit given voluntarily.

## Packs used (downloaded from kenney.nl on 26 Oct 2026, each page lists "License: Creative Commons CC0")

- Kenney City Kit (Commercial) 2.1: https://kenney.nl/assets/city-kit-commercial (buildings a to n, skyscrapers a to e, low-detail buildings)
- Kenney Nature Kit: https://kenney.nl/assets/nature-kit (rock_largeA to F, stone_largeA, C, E)

## Modifications

- Texture colours baked into flat vertex colours; light wall colours split into a separate `wall` material so the game tints walls with each section's palette.
- Blue-grey trim warmed to concrete tones, glass turned deep teal (Beirut look). Far buildings keep a recoloured 128 px colormap (`back` material).
- Added Beirut details to the front buildings: roof water tanks, solar heaters, antennas, balconies, AC units.
- Rocks recoloured to Corniche limestone.
- Welded, quantized (KHR_mesh_quantization) and compressed (EXT_meshopt_compression). Built with `tools/env/build.mjs`.
