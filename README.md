# ComfyBlockout

3D editor node for ComfyUI — build a blockout scene (primitives, GLB, FBX with animation, gaussian splats), record a keyframed camera path, and feed the rendered mp4 + start image + scene prompt straight into Seedance / Nano Banana / Flux / any downstream model.

![Fullscreen editor](docs/editor.png)

## What it does

- Drop the **ComfyBlockout** node onto your canvas — it ships with a live in-node 3D viewport.
- The node body shows a real-time three.js preview with a mini transport (record / play / rewind / add-key / clear) and a scrub timeline. Edit the scene without ever leaving the canvas.
- Click **Edit** in the in-node bar → fullscreen 3D editor opens with the full toolset: add primitives, import meshes, sculpt a camera path, save as a named project.

![Blockout → Nano Banana Pro pipeline](docs/nano-banana-pipeline.png)

- Three outputs ready to wire downstream:
  - `image` (IMAGE) — first frame / snapshot, wires into Seedance `image_N` slots, Nano Banana `images`, Flux text-to-image start image
  - `video` (VIDEO) — recorded mp4, wires into Seedance `video_1`, Wan motion ref, LTX
  - `prompt` (STRING) — editable system prompt, wires into Nano Banana / Flux / any text-to-image prompt input    

![ComfyBlockout node + Preview Image output](docs/node-preview.png)

## Features

**Scene building**
- 6 primitive blocks (cube, sphere, capsule, cylinder, cone, plane) auto-colored from a curated 12-color named palette so each block reads as "the **red** cube is the car driving down the street" when prompting
- Drag-and-drop import: GLB / GLTF / FBX (with AnimationMixer) / OBJ / PLY mesh / PLY+SPLAT+KSPLAT+SPZ gaussian splats
- Per-object color swatch + visibility toggle in the outliner
- Transform gizmo with Move / Rotate / Scale / Pivot modes (W / E / R)
- Studio HDRI environments (built-in + Polyhaven presets)

**Camera animation**
- Keyframe-based camera path with linear / ease-in / ease-out / ease-in/out per key
- Diamond keyframe handles above the timeline + grey position lines inside it (so the playhead never collides)
- Click to select + jump playhead to key, drag to retime, right-click for ease menu
- Arrow keys frame-step (← / →; Shift for ±10 frames)
- Playhead snaps to keyframes within 6px while scrubbing (Shift bypasses)
- Alt-modifier camera moves layered on top of the default orbit: free-look (Alt + left-drag) and roll / dutch angle (Alt + right-drag). Roll is preserved per keyframe so cinematic moves tween cleanly.
- Camera panel with Blender-style drag-fields: Pos X/Y/Z + Yaw/Pitch/Roll. Drag horizontally to scrub for micro-adjustments, click to type a value, Reset button restores the default view.

**Recording**
- `canvas.captureStream()` → MediaRecorder → ffmpeg → h264 mp4 with `+faststart` and yuv420p (so it actually plays everywhere)
- Aspect-ratio framing overlay (16:9, 9:16, 1:1, 4:5, 4:3, 21:9, free) with letterbox/pillarbox crop applied during conversion
- Duration + FPS controls — recordings auto-tween through your keyframes if you have ≥2

**Projects + persistence**
- Named server-side projects: New / Open / Save / Save As with Ctrl+S, list/delete via the Open modal
- Projects live at `<comfy_temp>/comfyblockout/projects/<name>/{scene.json, assets/}` and are shared across every ComfyBlockout node on the install
- Scene + imported asset bytes both auto-save per node, so reopening a workflow restores everything
- Stable UUID per node so freshly-dropped nodes don't collide on backend storage

## Controls

### Camera

| Action | Mouse / Key |
| --- | --- |
| Orbit around target | Left-drag |
| Pan | Right-drag |
| Dolly | Scroll wheel |
| Free-look (look around in place) | `Alt` + left-drag |
| Roll / dutch angle | `Alt` + right-drag |
| Frame the selected object (or all objects) | `F` |
| Reset camera to default | `Home` (or the `Reset` button in the Camera panel) |

The Camera panel has six drag-fields — Pos X / Y / Z and Yaw / Pitch / Roll. Drag horizontally on a box to scrub the value (sensitivity is small by default so micro-adjustments are natural), hold `Shift` while dragging for ×0.1 fine mode, or click without dragging to type a value directly.

### Transform

Click an object in the viewport or the outliner to select. The gizmo follows the current mode:

| Action | Key |
| --- | --- |
| Move (translate) | `W` |
| Rotate | `E` |
| Scale | `R` |
| Frame selection | `F` |
| Delete selected | `Delete` / `Backspace` |
| Duplicate selected | `Ctrl` + `D` |
| Copy / Cut / Paste | `Ctrl` + `C` / `X` / `V` |

### Timeline + playback

| Action | Key |
| --- | --- |
| Play / pause preview | `Space` |
| Step one frame | `←` / `→` |
| Step ten frames | `Shift` + `←` / `→` |
| Drop keyframe at playhead | `+` button in the timeline transport |
| Select keyframe + jump playhead | Click a diamond |
| Retime keyframe | Drag a diamond |
| Ease menu / delete keyframe | Right-click a diamond |

### Edit

| Action | Key |
| --- | --- |
| Undo | `Ctrl` + `Z` |
| Redo | `Ctrl` + `Shift` + `Z` (or `Ctrl` + `Y`) |
| Save project | `Ctrl` + `S` |

## Install

Drop or symlink this folder into your ComfyUI `custom_nodes`:

```
ComfyUI/custom_nodes/ComfyBlockout/
```

Or via ComfyUI-Manager: search "ComfyBlockout" and install.

Restart ComfyUI. The node appears under the **video** category.

## Requirements

Python deps (pinned in `pyproject.toml`, installed automatically by ComfyUI-Manager):
- `imageio-ffmpeg` — bundles a static ffmpeg binary used as a fallback for mp4 conversion when one isn't on PATH
- `opencv-python` — first-frame extraction for the IMAGE output when no snapshot exists
- `Pillow`, `numpy` — image loading + tensor conversion

ComfyUI itself provides `torch`, `aiohttp`, and (on a recent frontend) `comfy_api.input.video_types.VideoFromFile`. If `VideoFromFile` isn't available the VIDEO slot falls back to a path string.

**Optional but recommended:**
- A system `ffmpeg` on PATH — faster than the imageio-ffmpeg fallback and produces marginally smaller files. ComfyBlockout uses whichever it finds first (PATH → imageio-ffmpeg → no conversion). If neither is available, the VIDEO output stays as `.webm` which Seedance won't accept.

**Browser:** any modern Chromium / Firefox with WebGL 2 + ES modules + import maps (basically anything from the last three years). The editor + node body are both iframed three.js scenes.

## Quick start

1. Drop a ComfyBlockout node onto the canvas — it spawns with a single random-colored cube on a grid.
2. Click the edit icon in the in-node bar to open the full editor.
3. Add primitives or drop a GLB/FBX. Move them around with the gizmo.
4. Click **+** in the timeline to drop a keyframe at the current camera pose. Orbit the camera. Click **+** again at a new time. Repeat.
5. Hit **Record** (red dot) — recording length matches the Duration slider. mp4 lands on the node's `video` output and is saved as a project asset.
6. Wire the three outputs into Seedance / Nano Banana / Flux / Wan.

## Roadmap

- [x] Primitives, GLB, OBJ, FBX (+ animation)
- [x] PLY / SPLAT / KSPLAT / SPZ gaussian splat loading via sparkjs
- [x] Aspect-ratio framing overlay + cropped mp4 output
- [x] Scene + asset autosave / restore (full round-trip)
- [x] Editable prompt output with a model-tuned default
- [x] Keyframed camera path with per-key easing
- [x] Right-click ease menu (linear / in / out / in-out) + delete
- [x] Named projects (Save / Open / Save As / Ctrl+S)
- [x] In-node mini timeline + transport (record without opening the editor)
- [x] Per-object color picker in the outliner
- [ ] Visual-only "drop here" affordance when dragging files onto the in-node preview
- [ ] In-Worker splat parsing so the main thread doesn't pause on huge worldlabs / postshot captures

## License

See `LICENSE`.
