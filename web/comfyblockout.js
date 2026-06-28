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
    // Empty scene — no auto-seeded cube. Fresh nodes start blank; the user adds blocks
    // via the panel buttons or loads a project via Open. This avoids the "every tab
    // switch shows a new random-color cube" symptom that came from re-seeding when
    // the node UID didn't survive a workflow-tab round-trip.
    return {
        primitives: [],
        camera: { position: [2.2, 1.6, 2.8], target: [0, 0.5, 0], fov: 55 },
        aspect: "16:9",
        env: { preset: "studio", intensity: 1.0 },
        viewport: { grid: true, guides: false, bg: "#07080b" },
        keyframes: [],
        imports: [],
    };
}

const SEEDED_LS_KEY = "comfyblockout:seeded_uids";
function loadSeededSet() {
    try {
        const raw = localStorage.getItem(SEEDED_LS_KEY);
        return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
}
function markSeeded(nodeId) {
    try {
        const s = loadSeededSet();
        s.add(nodeId);
        localStorage.setItem(SEEDED_LS_KEY, JSON.stringify([...s]));
    } catch {}
}

async function seedDefaultIfEmpty(nodeId) {
    try {
        // Never re-seed a UID this browser has already seeded once. ComfyUI workflow-tab
        // switching has been observed to destroy + recreate node widgets, which re-fires
        // nodeCreated → seedDefaultIfEmpty. If for any reason /load_scene briefly returns
        // empty (transient race, temp folder housekeeping, server reload), a re-seed
        // would clobber the user's actual scene with a fresh default cube.
        const seeded = loadSeededSet();
        if (seeded.has(nodeId)) return false;

        const r = await fetch(`/comfyblockout/load_scene?node_id=${encodeURIComponent(nodeId)}`);
        const j = await r.json();
        if (j.scene) { markSeeded(nodeId); return false; } // already has saved state — record so we don't re-check

        await fetch("/comfyblockout/save_scene", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_id: nodeId, scene: buildDefaultScene() }),
        });
        markSeeded(nodeId);
        return true;
    } catch (e) {
        console.warn("[ComfyBlockout] default-scene seed failed:", e);
        return false;
    }
}

function getStableNodeId(node) {
    // LiteGraph assigns node.id = -1 for freshly-dropped, unsaved nodes — collision-prone.
    // Stamp a stable UUID on the node so it survives reload. We persist via TWO channels
    // because ComfyUI's workflow-tab switching has been observed to drop node.properties
    // even when the same workflow is re-entered:
    //   1) node.properties.comfyblockout_uid  — preferred, fast in-memory
    //   2) the "scene" widget's value         — survives widget_values serialization
    // On boot we read whichever is set, with the widget as the authoritative fallback,
    // and write back to both so subsequent reads agree.
    node.properties = node.properties || {};
    let uid = node.properties.comfyblockout_uid;
    if (!uid) {
        const sceneWidget = node.widgets?.find(w => w.name === "scene");
        const wv = typeof sceneWidget?.value === "string" ? sceneWidget.value.trim() : "";
        if (/^cb_[0-9a-f]+$/i.test(wv)) uid = wv;
    }
    if (!uid) {
        uid = "cb_" + (crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, "");
    }
    node.properties.comfyblockout_uid = uid;
    return uid;
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
    console.log("[ComfyBlockout] refreshThumbnail node", ui.nodeId, "→", fresh.src);
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

    // Expose the editor iframe so the live-sync forwarder can route preview→editor
    // scene updates while the editor is open.
    node.__c3dEditorIframe = iframe;

    const onMsg = async (ev) => {
        if (!ev.data || ev.data.source !== "comfy3d-editor") return;
        if (ev.data.type === "thumbnail-refresh") {
            if (node.__c3dRefresh) node.__c3dRefresh();
        } else if (ev.data.type === "closed") {
            node.__c3dEditorIframe = null;
            modal.remove();
            window.removeEventListener("message", onMsg);
            if (node.__c3dRefresh) node.__c3dRefresh();
        }
    };
    window.addEventListener("message", onMsg);
    const cleanupOnClose = () => {
        node.__c3dEditorIframe = null;
        window.removeEventListener("message", onMsg);
    };
    closeBtn.addEventListener("click", cleanupOnClose);
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

        // Live scene-sync forwarder: editor save → preview iframe (and vice versa) so both
        // viewports reflect the same state without waiting for the editor to close.
        const syncForwarder = (ev) => {
            if (!ev.data || ev.data.type !== "scene-sync") return;
            if (ev.data.source !== "comfy3d-editor" && ev.data.source !== "comfy3d-preview") return;
            if (String(ev.data.node_id) !== ui.nodeId) return;
            const target = ev.data.source === "comfy3d-editor"
                ? ui.previewFrame
                : node.__c3dEditorIframe;
            target?.contentWindow?.postMessage({
                source: "comfy3d-parent-sync",
                type: "scene-sync",
                node_id: ev.data.node_id,
                scene: ev.data.scene,
            }, "*");
        };
        window.addEventListener("message", syncForwarder);

        // Preview-refresh: editor asks the parent to fully rebuild the in-node iframe
        // from disk. Used after destructive operations (Open Project, etc.) where live
        // scene-sync isn't enough — eg the preview's deserializeScene chokes on a now-
        // copied asset and gives up silently. A full iframe rebuild always re-fetches.
        const refreshRequestHandler = (ev) => {
            if (!ev.data || ev.data.type !== "preview-refresh") return;
            if (String(ev.data.node_id) !== ui.nodeId) return;
            if (node.__c3dRefresh) node.__c3dRefresh();
        };
        window.addEventListener("message", refreshRequestHandler);

        // Force-snapshot bridge: parent (queuePrompt wrapper) asks the preview iframe to
        // flush a fresh render before the workflow submits. Resolves on ack with a 1.5s
        // safety timeout so a stuck iframe never blocks the queue button.
        node.__c3dForceSnapshot = () => new Promise(resolve => {
            const target = node.__c3dEditorIframe || ui.previewFrame;
            if (!target?.contentWindow) { resolve(); return; }
            let done = false;
            const onAck = (ev) => {
                if (done) return;
                if (ev.data?.type !== "force-snapshot-ack") return;
                if (String(ev.data.node_id) !== ui.nodeId) return;
                done = true;
                window.removeEventListener("message", onAck);
                resolve();
            };
            window.addEventListener("message", onAck);
            target.contentWindow.postMessage({
                source: "comfy3d-parent", type: "force-snapshot", node_id: ui.nodeId,
            }, "*");
            setTimeout(() => {
                if (done) return;
                done = true;
                window.removeEventListener("message", onAck);
                resolve();
            }, 1500);
        });

        // Refresh the preview iframe whenever the tab/window regains visibility so the
        // node body re-reads /load_scene with whatever UID the workflow restoration
        // currently has. Without this, switching ComfyUI workflow tabs can leave the
        // preview pointing at an obsolete UID while the rest of the node has moved on.
        const onVisible = () => {
            if (document.visibilityState === "visible" && node.__c3dRefresh) {
                node.__c3dRefresh();
            }
        };
        document.addEventListener("visibilitychange", onVisible);

        node.__c3dCleanup = () => {
            window.removeEventListener("message", editRequestHandler);
            window.removeEventListener("message", syncForwarder);
            document.removeEventListener("visibilitychange", onVisible);
        };

        const origSize = node.size?.slice();
        if (origSize && origSize[1] < 280) node.size[1] = 280;
        if (origSize && origSize[0] < 240) node.size[0] = 240;
    },

    async setup() {
        // Wrap app.queuePrompt so every ComfyBlockout node on the canvas flushes a fresh
        // snapshot before the workflow submits. OrbitControls damping + a small save/snap
        // debounce can otherwise leave the IMAGE output one frame behind the visible view.
        const original = app.queuePrompt.bind(app);
        app.queuePrompt = async (...args) => {
            try {
                const nodes = (app.graph?._nodes || []).filter(n => n.comfyClass === NODE_NAME);
                if (nodes.length) {
                    await Promise.all(nodes.map(n => n.__c3dForceSnapshot ? n.__c3dForceSnapshot() : Promise.resolve()));
                }
            } catch (e) {
                console.warn("[ComfyBlockout] force-snapshot before queue failed:", e);
            }
            return original(...args);
        };
    },
});

console.log("[ComfyBlockout] extension loaded");
