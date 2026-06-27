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


def _ffmpeg_available() -> bool:
    try:
        r = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


HAS_FFMPEG = _ffmpeg_available()
if not HAS_FFMPEG:
    print("[Comfy3D] ffmpeg not found in PATH — uploads will stay as webm")

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False
    print("[Comfy3D] cv2 not available — IMAGE output will be black fallback")

try:
    from comfy_api.input.video_types import VideoFromFile
    HAS_VIDEO_TYPE = True
except Exception:
    HAS_VIDEO_TYPE = False
    print("[Comfy3D] comfy_api VideoFromFile unavailable — VIDEO output will be a path string")


_video_store = {}
_image_store = {}
_scene_store = {}
_prompt_store = {}

DEFAULT_PROMPT = (
    "Render this blockout scene. Match the exact camera angle, composition, scale, "
    "and object orientation — but do not use the blockout to define the style, "
    "colors, or creative direction."
)


def _temp_dir() -> Path:
    d = Path(folder_paths.get_temp_directory()) / "comfy3d"
    d.mkdir(parents=True, exist_ok=True)
    return d


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
        node_key = str(unique_id) if unique_id else None

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
            print("[Comfy3D] No image or video saved — returning black placeholder")
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
                print(f"[Comfy3D] VideoFromFile failed, returning path: {e}")
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
                cmd = ["ffmpeg", "-y", "-i", str(raw_path)]
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
                    print(f"[Comfy3D] ffmpeg conversion failed (rc={r.returncode}): {r.stderr.decode(errors='ignore')[:300]}")
            except Exception as e:
                print(f"[Comfy3D] ffmpeg threw: {e}")

        _video_store[node_id] = {"path": str(final_path)}
        print(f"[Comfy3D] Saved video for node {node_id} → {final_path} ({len(file_bytes)/1024:.1f} KB raw, converted={converted})")
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
        print(f"[Comfy3D] Saved image for node {node_id} → {out_path} ({len(file_bytes)/1024:.1f} KB)")
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
        return web.Response(status=400, text="Invalid asset name")
    path = _asset_dir(node_id) / asset_name
    if not path.exists():
        return web.Response(status=404, text="Not found")
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
        print(f"[Comfy3D] save_scene node={node_id} primitives={n_prim} keyframes={n_keys} → {scene_path}")
        return web.json_response({"success": True, "path": str(scene_path)})
    except Exception as e:
        print(f"[Comfy3D] save_scene FAILED: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/comfyblockout/load_scene")
async def load_scene(request):
    try:
        node_id = request.query.get("node_id", "").strip()
        if not node_id:
            return web.json_response({"scene": None})
        if node_id in _scene_store:
            s = _scene_store[node_id]
            n_prim = len(s.get("primitives", [])) if isinstance(s, dict) else 0
            print(f"[Comfy3D] load_scene node={node_id} from memory · primitives={n_prim}")
            return web.json_response({"scene": s})
        scene_path = _temp_dir() / f"node_{node_id}.scene.json"
        if scene_path.exists():
            s = json.loads(scene_path.read_text(encoding="utf-8"))
            n_prim = len(s.get("primitives", [])) if isinstance(s, dict) else 0
            print(f"[Comfy3D] load_scene node={node_id} from disk · primitives={n_prim}")
            return web.json_response({"scene": s})
        print(f"[Comfy3D] load_scene node={node_id} → no saved scene")
        return web.json_response({"scene": None})
    except Exception as e:
        print(f"[Comfy3D] load_scene FAILED: {e}")
        return web.json_response({"scene": None, "error": str(e)})


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


NODE_CLASS_MAPPINGS = {
    "ComfyBlockout": ComfyBlockout,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ComfyBlockout": "ComfyBlockout",
}
