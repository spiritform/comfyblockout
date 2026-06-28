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
    // Fresh node = one cube + ground-friendly camera. Safe to re-seed now that
    // getStableNodeId no longer claims stale recent UIDs — a recreated node only
    // gets a new UID if both widget value and properties dropped (eg unsaved-
    // workflow tab switch), which the user signs up for by not saving the workflow.
    const color = DEFAULT_CUBE_PALETTE[Math.floor(Math.random() * DEFAULT_CUBE_PALETTE.length)];
    return {
        primitives: [{
            kind: "cube",
            name: "Cube",
            position: [0, 0.5, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            color,
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

const NODE_UID_LS_KEY = "comfyblockout:node_uids";
const RECENT_UIDS_KEY = "comfyblockout:recent_uids";

function loadNodeUidMap() {
    try { return JSON.parse(localStorage.getItem(NODE_UID_LS_KEY) || "{}") || {}; }
    catch { return {}; }
}
function saveNodeUid(litegraphId, uid) {
    try {
        if (litegraphId == null || litegraphId === -1) return;
        const m = loadNodeUidMap();
        m[String(litegraphId)] = uid;
        localStorage.setItem(NODE_UID_LS_KEY, JSON.stringify(m));
    } catch {}
}
function pushRecentUid(uid) {
    try {
        const list = JSON.parse(localStorage.getItem(RECENT_UIDS_KEY) || "[]");
        const i = list.indexOf(uid);
        if (i >= 0) list.splice(i, 1);
        list.unshift(uid);
        list.splice(16);
        localStorage.setItem(RECENT_UIDS_KEY, JSON.stringify(list));
    } catch {}
}
function loadRecentUids() {
    try { return JSON.parse(localStorage.getItem(RECENT_UIDS_KEY) || "[]"); }
    catch { return []; }
}

// True while we're inside app.loadGraphData / graph.configure — ie ComfyUI is restoring
// nodes from a workflow JSON, a tab switch, or a file load. nodeCreated callbacks that
// fire during this window are restorations, NOT fresh user drops, and may legally fall
// back to the recent-UIDs list when their widget value didn't survive. Fresh drops
// happen outside this window and still get a clean new UID + cube.
let isLoadingWorkflow = false;
function inWorkflowLoad() { return isLoadingWorkflow; }
function wrapLoader(target, methodName) {
    if (!target || typeof target[methodName] !== "function") return;
    const orig = target[methodName].bind(target);
    target[methodName] = function (...args) {
        const wasLoading = isLoadingWorkflow;
        isLoadingWorkflow = true;
        let result;
        try { result = orig(...args); }
        catch (e) { isLoadingWorkflow = wasLoading; throw e; }
        if (result && typeof result.then === "function") {
            return result.finally(() => { isLoadingWorkflow = wasLoading; });
        }
        // Sync: clear after the next microtask so the synchronously-fired nodeCreated
        // cascade still sees the flag (and any microtask-scheduled handlers do too).
        queueMicrotask(() => { isLoadingWorkflow = wasLoading; });
        return result;
    };
}
// Live ComfyBlockout UIDs in the current graph — used to filter recent-UIDs so the
// second node restoring doesn't grab the same one as the first.
function claimedUidsInGraph() {
    const claimed = new Set();
    try {
        for (const n of (window.__c3dApp?.graph?._nodes || [])) {
            if (n.comfyClass !== NODE_NAME) continue;
            const u = n.properties?.comfyblockout_uid;
            if (u) claimed.add(u);
        }
    } catch {}
    return claimed;
}

// True when this nodeCreated represents a real user drop — NOT a workflow restore /
// tab switch / file load. Restores never need a fresh cube; only user-initiated drops
// should seed one. Without this gate, tab returns kept clobbering saved scenes.
function isFreshNode(node) {
    if (inWorkflowLoad()) return false;
    if (node.properties?.comfyblockout_uid) return false;
    const sceneWidget = node.widgets?.find(w => w.name === "scene");
    const wv = typeof sceneWidget?.value === "string" ? sceneWidget.value.trim() : "";
    if (/^cb_[0-9a-f]+$/i.test(wv)) return false;
    if (node.id != null && node.id !== -1) {
        const stored = loadNodeUidMap()[String(node.id)];
        if (/^cb_[0-9a-f]+$/i.test(stored || "")) return false;
    }
    return true;
}

function getStableNodeId(node) {
    // LiteGraph assigns node.id = -1 for freshly-dropped, unsaved nodes — collision-prone.
    // Recovery channels (in order):
    //   1) node.properties.comfyblockout_uid  — fast in-memory, survives the session
    //   2) the "scene" widget's value         — survives workflow JSON save/load
    //   3) localStorage keyed by node.id      — survives if node.id was stable
    //
    // The previous "claim most recent UID" fallback was removed: it made freshly-dropped
    // nodes silently inherit some other node's scene, breaking the basic invariant that
    // a new node should be a new scene. The tradeoff: ComfyUI Desktop tab-switching on
    // an UNSAVED workflow drops channels 1+2 and resets node.id, so the scene appears
    // blank on return. Saving the workflow (Ctrl+S) before tab-switching keeps channel 2
    // intact and the scene survives.
    node.properties = node.properties || {};
    let uid = node.properties.comfyblockout_uid;
    if (!uid) {
        const sceneWidget = node.widgets?.find(w => w.name === "scene");
        const wv = typeof sceneWidget?.value === "string" ? sceneWidget.value.trim() : "";
        if (/^cb_[0-9a-f]+$/i.test(wv)) uid = wv;
    }
    if (!uid && node.id != null && node.id !== -1) {
        const m = loadNodeUidMap();
        const stored = m[String(node.id)];
        if (/^cb_[0-9a-f]+$/i.test(stored || "")) uid = stored;
    }
    // Channel 4: recent-UIDs fallback, ONLY during workflow loads / tab restores.
    // Fresh user drops never reach here (they fall through to minting a brand-new UID).
    // This is what makes scenes survive a tab switch on an unsaved workflow, without
    // letting a freshly-dropped node silently inherit someone else's saved state.
    if (!uid && inWorkflowLoad()) {
        const claimed = claimedUidsInGraph();
        const recent = loadRecentUids();
        const candidate = recent.find(u => /^cb_[0-9a-f]+$/i.test(u) && !claimed.has(u));
        if (candidate) uid = candidate;
    }
    if (!uid) {
        uid = "cb_" + (crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, "");
    }
    node.properties.comfyblockout_uid = uid;
    saveNodeUid(node.id, uid);
    pushRecentUid(uid);
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


// Module-level registry of open editor modals keyed by UID. A per-node guard isn't enough
// because ComfyUI Desktop's tab switching can leave behind stale node instances whose
// `editRequestHandler` window listeners never get torn down — every one of them fires on
// a single Edit click and opens its own modal for the same UID, which then required N
// Close clicks to peel apart and showed the wrong scene through the stack.
const OPEN_EDITORS = new Map();

function openEditor(node) {
    const nodeId = getStableNodeId(node);

    // Global guard: if any editor for this UID is already open (even from a stale node
    // instance), focus it and bail. Catches cross-instance stacking that the per-node
    // `node.__c3dEditorIframe` check missed.
    const existing = OPEN_EDITORS.get(nodeId);
    if (existing && document.body.contains(existing.modal)) {
        try { existing.iframe.contentWindow?.focus(); } catch {}
        return;
    }
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
    closeBtn.addEventListener("click", () => {
        // Tell the editor iframe to flush its save via sendBeacon. sendBeacon delivers
        // in the background even after the iframe is gone, BUT only if its message
        // handler actually runs first. postMessage is async — if we synchronously
        // modal.remove() the same tick, the iframe is destroyed before its event loop
        // dispatches the flush-save message, and the in-flight edit is lost (eg add a
        // sphere then immediately close → preview still shows the cube).
        // Two rAFs gives the message handler a chance to fire + queue sendBeacon
        // before the contentWindow goes away. ~32ms is still indistinguishable from
        // "instant" to a human clicking Close.
        try { iframe.contentWindow?.postMessage({ source: "comfy3d-parent", type: "flush-save" }, "*"); } catch {}
        requestAnimationFrame(() => requestAnimationFrame(() => doClose()));
    });
    const doClose = () => {
        modal.remove();
        // Ask the existing preview iframe to re-read /load_scene in place — avoids the
        // white flash from tearing down + rebuilding the iframe. Wait briefly for an ack,
        // and fall back to a full rebuild if it doesn't land. The fallback catches stale
        // extension JS, an iframe that's mid-rebuild, or a node_id mismatch — correctness
        // wins over flash-free.
        const pv = node.__c3dGetPreviewFrame?.();
        let acked = false;
        const onAck = (ev) => {
            if (ev.data?.type !== "reload-scene-ack") return;
            if (String(ev.data.node_id) !== nodeId) return;
            acked = true;
            window.removeEventListener("message", onAck);
        };
        window.addEventListener("message", onAck);
        setTimeout(() => {
            try {
                pv?.contentWindow?.postMessage(
                    { source: "comfy3d-parent", type: "reload-scene", node_id: nodeId },
                    "*",
                );
            } catch {}
            if (!pv) {
                window.removeEventListener("message", onAck);
                if (node.__c3dRefresh) node.__c3dRefresh();
                return;
            }
            setTimeout(() => {
                if (acked) return;
                window.removeEventListener("message", onAck);
                if (node.__c3dRefresh) node.__c3dRefresh();
            }, 600);
        }, 100);
    };
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
    OPEN_EDITORS.set(nodeId, { modal, iframe });

    const onMsg = async (ev) => {
        if (!ev.data || ev.data.source !== "comfy3d-editor") return;
        if (ev.data.type === "thumbnail-refresh") {
            if (node.__c3dRefresh) node.__c3dRefresh();
        } else if (ev.data.type === "closed") {
            OPEN_EDITORS.delete(nodeId);
            node.__c3dEditorIframe = null;
            modal.remove();
            window.removeEventListener("message", onMsg);
            if (node.__c3dRefresh) node.__c3dRefresh();
        }
    };
    window.addEventListener("message", onMsg);
    const cleanupOnClose = () => {
        OPEN_EDITORS.delete(nodeId);
        node.__c3dEditorIframe = null;
        window.removeEventListener("message", onMsg);
    };
    closeBtn.addEventListener("click", cleanupOnClose);
}


app.registerExtension({
    name: EXT_NAME,

    async nodeCreated(node) {
        if (node.comfyClass !== NODE_NAME) return;

        // Snapshot freshness BEFORE buildWidget runs, since getStableNodeId writes
        // node.properties.comfyblockout_uid and the "scene" widget — any later check
        // would always look recovered.
        const fresh = isFreshNode(node);
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
        // Expose the current preview iframe so openEditor's close handler can post
        // reload-scene to it without tearing the iframe down (which flashes the in-node
        // viewport white during the rebuild's three.js boot).
        node.__c3dGetPreviewFrame = () => ui.previewFrame;

        // Only seed a default cube for genuinely just-dropped nodes. Tab-switch returns,
        // workflow reloads, and project opens all hit a recovery channel — calling
        // seedDefaultIfEmpty there used to silently clobber existing saved scenes with
        // a cube on the next /load_scene race.
        if (fresh) {
            seedDefaultIfEmpty(ui.nodeId).then(seeded => {
                if (seeded) node.__c3dRefresh();
            });
        }

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
            window.removeEventListener("message", refreshRequestHandler);
            document.removeEventListener("visibilitychange", onVisible);
        };

        // LiteGraph fires onRemoved when a node leaves the graph (delete, workflow load,
        // tab switch on Desktop). Without this, every recreation left a fossilized set of
        // window listeners that all responded to `request-edit` for the recovered UID,
        // stacking up N editor modals from one click.
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function (...args) {
            try { node.__c3dCleanup?.(); } catch {}
            return origOnRemoved?.apply(this, args);
        };

        const origSize = node.size?.slice();
        if (origSize && origSize[1] < 280) node.size[1] = 280;
        if (origSize && origSize[0] < 240) node.size[0] = 240;
    },

    async setup() {
        // Expose app so claimedUidsInGraph can walk the live graph without re-importing.
        window.__c3dApp = app;

        // Mark workflow loads / tab restores so getStableNodeId can use the recent-UIDs
        // fallback during them — and isFreshNode can refuse to seed a cube. Without these
        // hooks, an unsaved-workflow tab return mints a new UID and overwrites the saved
        // scene with a fresh cube.
        wrapLoader(app, "loadGraphData");
        if (app.graph) wrapLoader(app.graph, "configure");

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
