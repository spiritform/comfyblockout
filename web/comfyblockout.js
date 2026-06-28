import { app } from "../../scripts/app.js";

const EXT_NAME = "comfyblockout";
const NODE_NAME = "ComfyBlockout";
const EDITOR_URL = "extensions/ComfyBlockout/editor.html";

const style = document.createElement("style");
style.textContent = `
.c3d-wrap {
    background: #1a1a20;
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    height: 100%;
    color: #ccc;
    font-family: -apple-system, "Inter", "Segoe UI", sans-serif;
    font-size: 11px;
}
.c3d-thumb {
    position: relative;
    flex: 1;
    min-height: 100px;
    background: #07080b;
    overflow: hidden;
}
.c3d-thumb iframe {
    width: 100%; height: 100%; border: none; display: block; background: #07080b;
}
.c3d-thumb video, .c3d-thumb canvas {
    width: 100%; height: 100%; object-fit: cover; display: block;
}
.c3d-thumb-empty {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.35);
    gap: 6px;
    text-align: center;
}
.c3d-thumb-empty .icon { font-size: 22px; opacity: 0.7; }
.c3d-thumb-empty .label { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
.c3d-status {
    position: absolute; bottom: 4px; left: 6px;
    font-size: 9px; color: rgba(255,255,255,0.45);
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, monospace;
    text-shadow: 0 1px 2px rgba(0,0,0,0.6);
}
.c3d-live {
    position: absolute; top: 4px; right: 6px;
    font-size: 9px; color: #5aff8a;
    letter-spacing: 0.1em; text-transform: uppercase;
    display: flex; align-items: center; gap: 4px;
}
.c3d-live::before {
    content: ""; width: 5px; height: 5px; border-radius: 50%; background: #5aff8a;
    box-shadow: 0 0 4px #5aff8a;
}
`;
document.head.appendChild(style);


function previewUrl(nodeId) {
    return `extensions/ComfyBlockout/editor.html?node_id=${encodeURIComponent(nodeId)}&mode=preview&t=${Date.now()}`;
}

// Same palette as editor.html → so the default cube reads as a clearly nameable color
// when it shows up in the preview iframe, and persists identically across reopens.
const DEFAULT_CUBE_PALETTE = [
    0xff3838, 0x3578ff, 0x35d854, 0xffd138, 0xff8a1f, 0xa047ff,
    0xff5fbf, 0x2cd9d9, 0xc7e93b, 0xe83ad1, 0xffffff, 0x444444,
];
function buildDefaultScene() {
    return {
        primitives: [{
            kind: "cube",
            name: "Cube.001",
            position: [0, 0.5, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            color: DEFAULT_CUBE_PALETTE[Math.floor(Math.random() * DEFAULT_CUBE_PALETTE.length)],
            visible: true,
        }],
        camera: { position: [2.2, 1.6, 2.8], target: [0, 0.5, 0], fov: 55 },
        aspect: "16:9",
        env: { preset: "studio", intensity: 1.0 },
        viewport: { grid: true, guides: false, bg: "#07080b" },
        keyframes: [],
        imports: [],
    };
}

async function seedDefaultIfEmpty(nodeId) {
    try {
        const r = await fetch(`/comfyblockout/load_scene?node_id=${encodeURIComponent(nodeId)}`);
        const j = await r.json();
        if (j.scene) return false; // already has saved state
        await fetch("/comfyblockout/save_scene", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_id: nodeId, scene: buildDefaultScene() }),
        });
        return true;
    } catch (e) {
        console.warn("[ComfyBlockout] default-scene seed failed:", e);
        return false;
    }
}

function getStableNodeId(node) {
    // LiteGraph assigns node.id = -1 for freshly-dropped, unsaved nodes — collision-prone.
    // Stamp a stable UUID on the node and persist it via node.properties so it survives reload.
    node.properties = node.properties || {};
    if (!node.properties.comfyblockout_uid) {
        node.properties.comfyblockout_uid = "cb_" + (crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, "");
    }
    return node.properties.comfyblockout_uid;
}

function buildWidget(node) {
    const nodeId = getStableNodeId(node);
    const wrap = document.createElement("div");
    wrap.className = "c3d-wrap";

    const thumb = document.createElement("div");
    thumb.className = "c3d-thumb";

    const previewFrame = document.createElement("iframe");
    previewFrame.src = previewUrl(nodeId);
    previewFrame.allow = "autoplay";
    thumb.appendChild(previewFrame);

    wrap.appendChild(thumb);

    return { wrap, thumb, previewFrame, nodeId };
}


function refreshThumbnail(node, ui) {
    // Tear down + recreate iframe — guarantees no cached state, no stale module instance
    if (!ui.thumb) return;
    const fresh = document.createElement("iframe");
    fresh.src = previewUrl(ui.nodeId);
    fresh.allow = "autoplay";
    ui.previewFrame?.remove();
    ui.thumb.appendChild(fresh);
    ui.previewFrame = fresh;
}


function openEditor(node) {
    const nodeId = getStableNodeId(node);
    const url = `${EDITOR_URL}?node_id=${encodeURIComponent(nodeId)}&t=${Date.now()}`;

    const modal = document.createElement("div");
    Object.assign(modal.style, {
        position: "fixed", inset: "0", zIndex: "9999",
        background: "rgba(0,0,0,0.85)", display: "flex",
        flexDirection: "column",
    });

    const bar = document.createElement("div");
    Object.assign(bar.style, {
        display: "flex", alignItems: "center", gap: "12px",
        padding: "8px 14px", background: "#0a0a0e",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        color: "#ccc", fontFamily: "Inter, sans-serif", fontSize: "12px",
    });
    bar.innerHTML = `<span style="letter-spacing:0.02em;color:#fff;font-weight:600;font-size:13px">ComfyBlockout</span>
        <span style="color:rgba(255,255,255,0.45);font-size:11px">3D Editor Node</span>
        <span style="color:rgba(255,255,255,0.3);font-family:ui-monospace,monospace;font-size:11px">#${nodeId}</span>`;

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close ✕";
    Object.assign(closeBtn.style, {
        marginLeft: "auto",
        background: "rgba(255,255,255,0.08)", border: "none",
        color: "#fff", padding: "6px 12px", borderRadius: "6px",
        cursor: "pointer", fontFamily: "inherit", fontSize: "11px",
    });
    closeBtn.addEventListener("click", async () => {
        closeBtn.textContent = "Saving…";
        closeBtn.disabled = true;
        try {
            const acked = new Promise(resolve => {
                const onAck = (ev) => {
                    if (ev.data?.source === "comfy3d-editor" && ev.data?.type === "save-complete") {
                        window.removeEventListener("message", onAck);
                        resolve();
                    }
                };
                window.addEventListener("message", onAck);
                setTimeout(() => { window.removeEventListener("message", onAck); resolve(); }, 5000);
            });
            iframe.contentWindow?.postMessage({ source: "comfy3d-parent", type: "flush-save" }, "*");
            await acked;
        } catch {}
        modal.remove();
        if (node.__c3dRefresh) node.__c3dRefresh();
    });
    bar.appendChild(closeBtn);

    const iframe = document.createElement("iframe");
    Object.assign(iframe.style, {
        flex: "1", border: "none", width: "100%", background: "#0a0a0e",
    });
    iframe.src = url;

    modal.appendChild(bar);
    modal.appendChild(iframe);
    document.body.appendChild(modal);

    const onMsg = async (ev) => {
        if (!ev.data || ev.data.source !== "comfy3d-editor") return;
        if (ev.data.type === "thumbnail-refresh") {
            if (node.__c3dRefresh) node.__c3dRefresh();
        } else if (ev.data.type === "closed") {
            modal.remove();
            window.removeEventListener("message", onMsg);
            if (node.__c3dRefresh) node.__c3dRefresh();
        }
    };
    window.addEventListener("message", onMsg);
    closeBtn.addEventListener("click", () => window.removeEventListener("message", onMsg));
}


app.registerExtension({
    name: EXT_NAME,

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_NAME) return;

        const ui = buildWidget(node);

        // Pipe the stable UID into the "scene" widget so process() can recover the right
        // asset/scene storage key — LiteGraph node.id is unreliable for fresh/unsaved nodes.
        const sceneWidget = node.widgets?.find(w => w.name === "scene");
        if (sceneWidget) {
            sceneWidget.value = ui.nodeId;
            sceneWidget.serializeValue = () => ui.nodeId;
        }

        node.addDOMWidget("preview", "div", ui.wrap, {
            serialize: false,
            getHeight: () => 220,
        });

        node.__c3dRefresh = () => refreshThumbnail(node, ui);

        // Seed a default cube scene if this UID has nothing saved yet, then nudge the iframe.
        seedDefaultIfEmpty(ui.nodeId).then(seeded => {
            if (seeded) node.__c3dRefresh();
        });

        // Preview iframe's Edit Scene button posts request-edit; route to openEditor for this node.
        const editRequestHandler = (ev) => {
            if (ev.data?.source !== "comfyblockout-editor" || ev.data?.type !== "request-edit") return;
            if (String(ev.data.node_id) !== ui.nodeId) return;
            openEditor(node);
        };
        window.addEventListener("message", editRequestHandler);
        node.__c3dCleanup = () => window.removeEventListener("message", editRequestHandler);

        const origSize = node.size?.slice();
        if (origSize && origSize[1] < 280) node.size[1] = 280;
        if (origSize && origSize[0] < 240) node.size[0] = 240;
    },
});

console.log("[ComfyBlockout] extension loaded");
