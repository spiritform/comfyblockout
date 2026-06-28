import base64
import io
import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import torch
from aiohttp import web
from PIL import Image

import folder_paths
from server import PromptServer


def _resolve_ffmpeg() -> str | None:
    """Find a usable ffmpeg binary — PATH first, then imageio-ffmpeg's bundled copy.
    Returns the absolute path (or 'ffmpeg' when it's on PATH) or None if nothing works."""
    # 1) PATH
    try:
        r = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        if r.returncode == 0:
            return "ffmpeg"
    except Exception:
        pass
    # 2) imageio-ffmpeg ships a static ffmpeg binary; many ComfyUI installs already have it
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        r = subprocess.run([exe, "-version"], capture_output=True, timeout=5)
        if r.returncode == 0:
            print(f"[ComfyBlockout] using bundled ffmpeg from imageio-ffmpeg: {exe}")
            return exe
    except Exception:
        pass
    return None


FFMPEG_BIN = _resolve_ffmpeg()
HAS_FFMPEG = FFMPEG_BIN is not None
if not HAS_FFMPEG:
    print("[ComfyBlockout] ffmpeg not found (PATH or imageio-ffmpeg) — recordings will stay as .webm. "
          "Install ffmpeg or `pip install imageio-ffmpeg` so Seedance / Nano Banana can consume the .mp4 output.")

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False
    print("[ComfyBlockout] cv2 not available — IMAGE output will be black fallback")

# VideoFromFile lives in different paths across ComfyUI versions. The original import
# we used (`comfy_api.input.video_types`) only re-exports VideoInput these days, so the
# import was silently failing and process() was returning a plain str — which breaks
# downstream nodes (Seedance's `'str' object has no attribute 'get_dimensions'`).
VideoFromFile = None
for _modpath in (
    "comfy_api.latest._input_impl.video_types",
    "comfy_api.input_impl.video_types",
    "comfy_api.input.video_types",
):
    try:
        _mod = __import__(_modpath, fromlist=["VideoFromFile"])
        if hasattr(_mod, "VideoFromFile"):
            VideoFromFile = getattr(_mod, "VideoFromFile")
            break
    except Exception:
        pass
HAS_VIDEO_TYPE = VideoFromFile is not None
if not HAS_VIDEO_TYPE:
    print("[ComfyBlockout] comfy_api VideoFromFile unavailable — VIDEO output will be a path string")
else:
    print(f"[ComfyBlockout] VideoFromFile resolved from {VideoFromFile.__module__}")


_video_store = {}
_image_store = {}
_scene_store = {}
_prompt_store = {}

DEFAULT_PROMPT = (
    "Render this blockout scene. Match the exact camera angle, composition, scale, "
    "aspect ration and object orientations — but do not use the blockout to define "
    "the style, colors, or creative direction. Only use the grid as reference for "
    "the scene perspective and not as an element to include in the generated image or video"
)


_PLUGIN_DIR = Path(__file__).resolve().parent
_DATA_DIR = _PLUGIN_DIR / "data"


def _temp_dir() -> Path:
    # All persistent data — scenes, assets, recordings, named projects — lives in
    # `<custom_nodes>/ComfyBlockout/data/` so it survives ComfyUI restarts (Desktop
    # wipes the temp folder) and is obvious to find / back up.
    _DATA_DIR.mkdir(parents=True, exist_ok=True)

    # One-shot migration of any existing data from the old temp location so people
    # upgrading don't lose work that was already there.
    try:
        old = Path(folder_paths.get_temp_directory()) / "comfy3d"
        if old.exists() and old != _DATA_DIR:
            for item in old.iterdir():
                target = _DATA_DIR / item.name
                if target.exists():
                    continue
                try:
                    if item.is_dir():
                        shutil.copytree(item, target)
                    else:
                        shutil.copy2(item, target)
                except Exception:
                    pass
    except Exception:
        pass

    return _DATA_DIR


def load_image_tensor(path: Path) -> torch.Tensor:
    img = Image.open(path).convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def extract_first_frame(video_path: Path) -> torch.Tensor:
    if not HAS_CV2:
        return torch.zeros(1, 512, 512, 3)
    cap = cv2.VideoCapture(str(video_path))
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        return torch.zeros(1, 512, 512, 3)
    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    arr = frame_rgb.astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


class ComfyBlockout:
    """
    Build a 3D blockout scene in the editor, record a camera path, and pipe
    the rendered mp4 into video models like ByteDance Seedance 2.0 R2V.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "scene": ("STRING", {"default": "", "multiline": False}),
                "video_ref": ("STRING", {"default": "", "multiline": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "VIDEO", "STRING")
    RETURN_NAMES = ("image", "video", "prompt")
    FUNCTION = "process"
    CATEGORY = "video"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def process(self, scene="", video_ref="", unique_id=None):
        # `scene` carries the frontend's stable UUID (see comfyblockout.js getStableNodeId).
        # Falls back to unique_id when the workflow is already saved + IDs are stable.
        node_key = scene.strip() if scene else (str(unique_id) if unique_id else None)

        video_path = None
        if node_key and node_key in _video_store:
            candidate = Path(_video_store[node_key]["path"])
            if candidate.exists():
                video_path = candidate
        if video_path is None and video_ref:
            candidate = Path(video_ref)
            if candidate.exists():
                video_path = candidate

        image_path = None
        if node_key and node_key in _image_store:
            candidate = Path(_image_store[node_key]["path"])
            if candidate.exists():
                image_path = candidate

        if image_path is not None:
            img = load_image_tensor(image_path)
        elif video_path is not None:
            img = extract_first_frame(video_path)
        else:
            print("[ComfyBlockout] No image or video saved — returning black placeholder")
            img = torch.zeros(1, 512, 512, 3)

        prompt = _prompt_store.get(node_key, DEFAULT_PROMPT) if node_key else DEFAULT_PROMPT

        return (img, self._make_video_output(video_path), prompt)

    def _make_video_output(self, path):
        if path is None:
            placeholder = _temp_dir() / "empty.mp4"
            return str(placeholder)
        if HAS_VIDEO_TYPE:
            try:
                return VideoFromFile(str(path))
            except Exception as e:
                print(f"[ComfyBlockout] VideoFromFile failed, returning path: {e}")
        return str(path)


@PromptServer.instance.routes.post("/comfyblockout/save_video")
async def save_video(request):
    """Editor uploads a recorded mp4. We persist it under temp/comfyblockout/<node_id>.mp4
    and remember the path keyed by node_id so process() can pick it up."""
    try:
        reader = await request.multipart()
        node_id = None
        file_bytes = None
        filename_hint = "render.mp4"
        aspect = None
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.name == "node_id":
                node_id = (await field.read(decode=True)).decode("utf-8").strip()
            elif field.name == "aspect":
                aspect = (await field.read(decode=True)).decode("utf-8").strip()
            elif field.name == "video":
                file_bytes = await field.read(decode=False)
                if field.filename:
                    filename_hint = field.filename

        if not node_id or file_bytes is None:
            return web.json_response({"success": False, "error": "Missing node_id or video"}, status=400)

        suffix = Path(filename_hint).suffix.lower() or ".webm"
        raw_path = _temp_dir() / f"node_{node_id}_raw{suffix}"
        raw_path.write_bytes(file_bytes)

        crop_filter = None
        if aspect and ":" in aspect:
            try:
                a, b = aspect.split(":")
                a, b = int(a), int(b)
                crop_filter = f"crop='if(gt(a,{a}/{b}),ih*{a}/{b},iw)':'if(gt(a,{a}/{b}),ih,iw*{b}/{a})',scale=trunc(iw/2)*2:trunc(ih/2)*2"
            except Exception:
                crop_filter = None

        final_path = raw_path
        converted = False
        if HAS_FFMPEG and suffix != ".mp4":
            mp4_path = _temp_dir() / f"node_{node_id}.mp4"
            try:
                cmd = [FFMPEG_BIN, "-y", "-i", str(raw_path)]
                if crop_filter:
                    cmd += ["-vf", crop_filter]
                cmd += [
                    "-c:v", "libx264",
                    "-preset", "fast",
                    "-crf", "18",
                    "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart",
                    "-an",
                    str(mp4_path),
                ]
                r = subprocess.run(cmd, capture_output=True, timeout=120)
                if r.returncode == 0 and mp4_path.exists():
                    final_path = mp4_path
                    converted = True
                    try:
                        raw_path.unlink()
                    except Exception:
                        pass
                else:
                    print(f"[ComfyBlockout] ffmpeg conversion failed (rc={r.returncode}): {r.stderr.decode(errors='ignore')[:300]}")
            except Exception as e:
                print(f"[ComfyBlockout] ffmpeg threw: {e}")

        _video_store[node_id] = {"path": str(final_path)}
        print(f"[ComfyBlockout] Saved video for node {node_id} → {final_path} ({len(file_bytes)/1024:.1f} KB raw, converted={converted})")
        return web.json_response({"success": True, "path": str(final_path), "bytes": len(file_bytes), "mp4": converted})

    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/comfyblockout/save_image")
async def save_image(request):
    """Editor uploads a still PNG snapshot. We persist it and remember the path
    keyed by node_id so process() can use it for the IMAGE output."""
    try:
        reader = await request.multipart()
        node_id = None
        file_bytes = None
        filename_hint = "snapshot.png"
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.name == "node_id":
                node_id = (await field.read(decode=True)).decode("utf-8").strip()
            elif field.name == "image":
                file_bytes = await field.read(decode=False)
                if field.filename:
                    filename_hint = field.filename

        if not node_id or file_bytes is None:
            return web.json_response({"success": False, "error": "Missing node_id or image"}, status=400)

        suffix = Path(filename_hint).suffix.lower() or ".png"
        out_path = _temp_dir() / f"node_{node_id}_image{suffix}"
        out_path.write_bytes(file_bytes)
        _image_store[node_id] = {"path": str(out_path)}
        print(f"[ComfyBlockout] Saved image for node {node_id} → {out_path} ({len(file_bytes)/1024:.1f} KB)")
        return web.json_response({"success": True, "path": str(out_path), "bytes": len(file_bytes)})

    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/comfyblockout/save_prompt")
async def save_prompt(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id", "")).strip()
        prompt = data.get("prompt", "")
        if not node_id:
            return web.json_response({"success": False, "error": "Missing node_id"}, status=400)
        _prompt_store[node_id] = prompt
        path = _temp_dir() / f"node_{node_id}.prompt.txt"
        path.write_text(prompt, encoding="utf-8")
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/comfyblockout/load_prompt")
async def load_prompt(request):
    try:
        node_id = request.query.get("node_id", "").strip()
        if not node_id:
            return web.json_response({"prompt": DEFAULT_PROMPT})
        if node_id in _prompt_store:
            return web.json_response({"prompt": _prompt_store[node_id]})
        path = _temp_dir() / f"node_{node_id}.prompt.txt"
        if path.exists():
            text = path.read_text(encoding="utf-8")
            _prompt_store[node_id] = text
            return web.json_response({"prompt": text})
        return web.json_response({"prompt": DEFAULT_PROMPT})
    except Exception as e:
        return web.json_response({"prompt": DEFAULT_PROMPT, "error": str(e)})


def _asset_dir(node_id: str) -> Path:
    d = _temp_dir() / "assets" / node_id
    d.mkdir(parents=True, exist_ok=True)
    return d


_SAFE_ASSET_ID = re.compile(r"^[a-zA-Z0-9_\-]+$")
_SAFE_EXT = re.compile(r"^[a-zA-Z0-9]{1,6}$")


@PromptServer.instance.routes.post("/comfyblockout/save_asset")
async def save_asset(request):
    """Persist an imported asset (GLB/OBJ/PLY/SPLAT/SPZ) so the scene can re-load it."""
    try:
        reader = await request.multipart()
        node_id = asset_id = ext = None
        file_bytes = None
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.name == "node_id":
                node_id = (await field.read(decode=True)).decode("utf-8").strip()
            elif field.name == "asset_id":
                asset_id = (await field.read(decode=True)).decode("utf-8").strip()
            elif field.name == "ext":
                ext = (await field.read(decode=True)).decode("utf-8").strip().lower().lstrip(".")
            elif field.name == "file":
                file_bytes = await field.read(decode=False)
        if not node_id or not asset_id or not ext or file_bytes is None:
            return web.json_response({"success": False, "error": "Missing field"}, status=400)
        if not _SAFE_ASSET_ID.match(asset_id) or not _SAFE_EXT.match(ext):
            return web.json_response({"success": False, "error": "Invalid id/ext"}, status=400)
        path = _asset_dir(node_id) / f"{asset_id}.{ext}"
        path.write_bytes(file_bytes)
        print(f"[ComfyBlockout] save_asset node={node_id} id={asset_id} ext={ext} → {path} ({len(file_bytes)/1024:.1f} KB)")
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/comfyblockout/asset/{node_id}/{asset_name}")
async def serve_asset(request):
    node_id = request.match_info["node_id"]
    asset_name = request.match_info["asset_name"]
    if "/" in asset_name or "\\" in asset_name or ".." in asset_name:
        print(f"[ComfyBlockout] asset BAD-NAME node={node_id} name={asset_name}")
        return web.Response(status=400, text="Invalid asset name")
    path = _asset_dir(node_id) / asset_name
    if not path.exists():
        print(f"[ComfyBlockout] asset 404 node={node_id} name={asset_name} → {path}")
        return web.Response(status=404, text="Not found")
    print(f"[ComfyBlockout] asset 200 node={node_id} name={asset_name} ({path.stat().st_size} bytes)")
    return web.FileResponse(path, headers={"Content-Type": "application/octet-stream"})


@PromptServer.instance.routes.post("/comfyblockout/save_scene")
async def save_scene(request):
    """Editor saves scene JSON (object transforms, camera path, etc.) so reopening
    the editor restores the same blockout."""
    try:
        # sendBeacon arrives as raw bytes — fall back to .read() if json() fails
        try:
            data = await request.json()
        except Exception:
            raw = await request.read()
            data = json.loads(raw.decode("utf-8"))
        node_id = str(data.get("node_id", "")).strip()
        scene = data.get("scene", {})
        if not node_id:
            return web.json_response({"success": False, "error": "Missing node_id"}, status=400)
        _scene_store[node_id] = scene
        scene_path = _temp_dir() / f"node_{node_id}.scene.json"
        scene_path.write_text(json.dumps(scene), encoding="utf-8")
        n_prim = len(scene.get("primitives", [])) if isinstance(scene, dict) else 0
        n_keys = len(scene.get("keyframes", [])) if isinstance(scene, dict) else 0
        print(f"[ComfyBlockout] save_scene node={node_id} primitives={n_prim} keyframes={n_keys} → {scene_path}")
        return web.json_response({"success": True, "path": str(scene_path)})
    except Exception as e:
        print(f"[ComfyBlockout] save_scene FAILED: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


_NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}


@PromptServer.instance.routes.get("/comfyblockout/load_scene")
async def load_scene(request):
    try:
        node_id = request.query.get("node_id", "").strip()
        if not node_id:
            return web.json_response({"scene": None}, headers=_NO_CACHE)
        if node_id in _scene_store:
            s = _scene_store[node_id]
            n_prim = len(s.get("primitives", [])) if isinstance(s, dict) else 0
            n_imp = len(s.get("imports", [])) if isinstance(s, dict) else 0
            print(f"[ComfyBlockout] load_scene node={node_id} from memory · primitives={n_prim} imports={n_imp}")
            return web.json_response({"scene": s}, headers=_NO_CACHE)
        scene_path = _temp_dir() / f"node_{node_id}.scene.json"
        if scene_path.exists():
            s = json.loads(scene_path.read_text(encoding="utf-8"))
            n_prim = len(s.get("primitives", [])) if isinstance(s, dict) else 0
            n_imp = len(s.get("imports", [])) if isinstance(s, dict) else 0
            print(f"[ComfyBlockout] load_scene node={node_id} from disk · primitives={n_prim} imports={n_imp}")
            return web.json_response({"scene": s}, headers=_NO_CACHE)
        print(f"[ComfyBlockout] load_scene node={node_id} → no saved scene")
        return web.json_response({"scene": None}, headers=_NO_CACHE)
    except Exception as e:
        print(f"[ComfyBlockout] load_scene FAILED: {e}")
        return web.json_response({"scene": None, "error": str(e)}, headers=_NO_CACHE)


@PromptServer.instance.routes.get("/comfyblockout/video_url")
async def video_url(request):
    """Returns a URL the editor / node thumbnail can use to preview the rendered mp4."""
    try:
        node_id = request.query.get("node_id", "").strip()
        if not node_id or node_id not in _video_store:
            return web.json_response({"url": None})
        path = Path(_video_store[node_id]["path"])
        if not path.exists():
            return web.json_response({"url": None})
        return web.json_response({"url": f"/comfyblockout/video/{node_id}"})
    except Exception as e:
        return web.json_response({"url": None, "error": str(e)})


@PromptServer.instance.routes.get("/comfyblockout/video/{node_id}")
async def serve_video(request):
    node_id = request.match_info["node_id"]
    info = _video_store.get(node_id)
    if not info:
        return web.Response(status=404)
    path = Path(info["path"])
    if not path.exists():
        return web.Response(status=404)
    ctype = "video/mp4" if path.suffix.lower() == ".mp4" else "video/webm"
    return web.FileResponse(path, headers={"Content-Type": ctype})


@PromptServer.instance.routes.get("/comfyblockout/image_url")
async def image_url(request):
    try:
        node_id = request.query.get("node_id", "").strip()
        if not node_id or node_id not in _image_store:
            return web.json_response({"url": None})
        path = Path(_image_store[node_id]["path"])
        if not path.exists():
            return web.json_response({"url": None})
        return web.json_response({"url": f"/comfyblockout/image/{node_id}"})
    except Exception as e:
        return web.json_response({"url": None, "error": str(e)})


@PromptServer.instance.routes.get("/comfyblockout/image/{node_id}")
async def serve_image(request):
    node_id = request.match_info["node_id"]
    info = _image_store.get(node_id)
    if not info:
        return web.Response(status=404)
    path = Path(info["path"])
    if not path.exists():
        return web.Response(status=404)
    suffix = path.suffix.lower()
    ctype = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(suffix.lstrip("."), "image/png")
    return web.FileResponse(path, headers={"Content-Type": ctype})


_SAFE_PROJECT_NAME = re.compile(r"^[a-zA-Z0-9 _\-\.\(\)]{1,80}$")


def _projects_root() -> Path:
    d = _temp_dir() / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _project_dir(name: str) -> Path:
    return _projects_root() / name


@PromptServer.instance.routes.get("/comfyblockout/projects/list")
async def list_projects(request):
    try:
        root = _projects_root()
        names = sorted([p.name for p in root.iterdir() if p.is_dir() and (p / "scene.json").exists()])
        return web.json_response({"projects": names})
    except Exception as e:
        return web.json_response({"projects": [], "error": str(e)})


@PromptServer.instance.routes.post("/comfyblockout/projects/save")
async def save_project(request):
    """Snapshot the current node's scene + assets into a named project folder."""
    try:
        data = await request.json()
        node_id = str(data.get("node_id", "")).strip()
        name = str(data.get("name", "")).strip()
        scene = data.get("scene")
        if not node_id or not name or scene is None:
            return web.json_response({"success": False, "error": "Missing node_id, name, or scene"}, status=400)
        if not _SAFE_PROJECT_NAME.match(name):
            return web.json_response({"success": False, "error": "Invalid project name (a-z, 0-9, space, _, -, ., parens)"}, status=400)

        pdir = _project_dir(name)
        # Wipe existing project assets so deleted imports don't linger.
        if pdir.exists():
            shutil.rmtree(pdir)
        (pdir / "assets").mkdir(parents=True, exist_ok=True)

        # Copy every asset referenced in scene.imports[] from the node's asset dir → project dir.
        src_assets = _asset_dir(node_id)
        copied = 0
        for im in (scene.get("imports", []) or []):
            asset_id = im.get("assetId")
            filename = im.get("filename") or ""
            ext = filename.split(".")[-1].lower() if "." in filename else "bin"
            if not asset_id:
                continue
            src = src_assets / f"{asset_id}.{ext}"
            if src.exists():
                shutil.copy2(src, pdir / "assets" / src.name)
                copied += 1

        (pdir / "scene.json").write_text(json.dumps(scene, indent=2), encoding="utf-8")
        print(f"[ComfyBlockout] save_project name={name} assets={copied} → {pdir}")
        return web.json_response({"success": True, "assets": copied})
    except Exception as e:
        print(f"[ComfyBlockout] save_project FAILED: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/comfyblockout/projects/load")
async def load_project(request):
    """Copy a project's assets into the calling node's asset dir, then return scene JSON."""
    try:
        data = await request.json()
        node_id = str(data.get("node_id", "")).strip()
        name = str(data.get("name", "")).strip()
        if not node_id or not name or not _SAFE_PROJECT_NAME.match(name):
            return web.json_response({"success": False, "error": "Bad node_id or name"}, status=400)

        pdir = _project_dir(name)
        scene_path = pdir / "scene.json"
        if not scene_path.exists():
            return web.json_response({"success": False, "error": "Project not found"}, status=404)

        # Copy project assets into the node's asset dir so existing serve_asset URLs resolve.
        dest = _asset_dir(node_id)
        src_assets = pdir / "assets"
        copied = 0
        if src_assets.exists():
            for f in src_assets.iterdir():
                if f.is_file():
                    shutil.copy2(f, dest / f.name)
                    copied += 1

        scene = json.loads(scene_path.read_text(encoding="utf-8"))
        # Persist into this node's scene store so a reopen of the node body picks it up.
        _scene_store[node_id] = scene
        (_temp_dir() / f"node_{node_id}.scene.json").write_text(json.dumps(scene), encoding="utf-8")
        print(f"[ComfyBlockout] load_project name={name} → node {node_id} (assets={copied})")
        return web.json_response({"success": True, "scene": scene, "assets": copied})
    except Exception as e:
        print(f"[ComfyBlockout] load_project FAILED: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/comfyblockout/projects/delete")
async def delete_project(request):
    try:
        data = await request.json()
        name = str(data.get("name", "")).strip()
        if not name or not _SAFE_PROJECT_NAME.match(name):
            return web.json_response({"success": False, "error": "Bad name"}, status=400)
        pdir = _project_dir(name)
        if pdir.exists():
            shutil.rmtree(pdir)
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


NODE_CLASS_MAPPINGS = {
    "ComfyBlockout": ComfyBlockout,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ComfyBlockout": "ComfyBlockout",
}
