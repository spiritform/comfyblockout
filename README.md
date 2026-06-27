# ComfyBlockout

3D Editor Node for ComfyUI — build a blockout scene (primitives, GLB, gaussian splats), record a camera path, and feed the rendered video + start image + scene prompt straight into Seedance / Nano Banana / Flux / any downstream model.

## What it does

- Drop the **ComfyBlockout** node onto your canvas
- Node body shows a live preview thumbnail of the last snapshot or render
- Click **Edit Scene** → fullscreen 3D editor opens
- Add primitives (cube, sphere, capsule, cylinder, cone, plane); drop GLB / OBJ / PLY / SPLAT
- Move / rotate / scale with the gizmo (W / E / R)
- **Snapshot** → auto-saves to the `image` output
- **Record** → auto-saves the cropped mp4 to the `video` output
- Editable prompt textarea → routes to the `prompt` output

Three outputs ready to wire into downstream nodes:
- `image` (IMAGE) — wires into Seedance `image_N` slots, Nano Banana `images`, etc.
- `video` (VIDEO) — wires into Seedance `video_1`, Wan motion ref, LTX, etc.
- `prompt` (STRING) — wires into Nano Banana / Flux / any text-to-image prompt input

## Install (dev / local testing)

Copy or symlink this folder into your ComfyUI `custom_nodes`:

```
H:\ComfyUI-Easy-Install\ComfyUI\custom_nodes\comfy3d\
```

Restart ComfyUI. The node appears under the **video** category.

## Roadmap

- [x] GLB / OBJ drop-import
- [x] PLY / SPLAT loading via sparkjs
- [x] Aspect-ratio framing overlay + crop on output (image + ffmpeg)
- [x] Scene autosave / restore (primitives + camera + aspect)
- [x] mp4 (h264) output via ffmpeg
- [x] Editable prompt output
- [ ] Keyframed camera path (timeline scrubber)
- [ ] Asset persistence for GLB / OBJ / splat (currently primitives only round-trip)
- [ ] In-Worker splat parsing for huge worldlabs / postshot captures
