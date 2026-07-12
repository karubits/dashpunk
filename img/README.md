# Images

Screenshots and gifs used by the main README. All theme captures were taken
on the real hardware (Xeneon Edge, 2560x720, KDE Plasma 6) with a sanitized
config, cropped to the Edge output and scaled down for fast page loads.

| File | Status | What it shows |
|---|---|---|
| `intro.gif` | done | README hero: quick cuts through all five themes and several pages, personal regions blurred |
| `hero.png` | wanted | A desk photo of the Edge running Dashpunk (photo beats screenshot) |
| `theme-cyberpunk.gif` | done | Dash page; includes a GPU glitch burst |
| `theme-cyberpunk.png` | done | Still of the same |
| `theme-lcars.png` | done | LCARS chrome, segmented rail, pill controls |
| `theme-catppuccin.gif` | done | Sakura falling and a paw trail mid-walk |
| `theme-catppuccin.png` | done | Still of the same |
| `theme-monokai.png` | done | Monokai Pro palette |
| `theme-mayukai.png` | done | Mayukai Mirage palette |
| `theme-dracula.png` | done | Official Dracula spec palette |

To recapture: KDE `spectacle -b -n -f -o full.png`, then crop the Edge
region (`magick full.png -crop 2560x720+X+Y +repage`, offsets from
`kscreen-doctor -o`) and resize to 1600 wide (stills) or 1200 (gif frames,
assembled with `magick -delay 55 -loop 0 f*.png -layers OptimizeFrame`).
