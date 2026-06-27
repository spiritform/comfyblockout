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
    background:
        radial-gradient(ellipse 60% 70% at 50% 55%, rgba(60,80,110,0.18), transparent 70%),
        linear-gradient(180deg, #0c0d12 0%, #07080b 100%);
    overflow: hidden;
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
.c3d-edit-btn {
    background: rgba(255,255,255,0.08);
    border: none;
    color: #fff;
    padding: 8px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    font-family: inherit;
    border-top: 1px solid rgba(255,255,255,0.06);
}
.c3d-edit-btn:hover { background: rgba(255,255,255,0.14); }
`;
document.head.appendChild(style);


function buildWidget(node) {
    const wrap = document.createElement("div");
    wrap.className = "c3d-wrap";

    const thumb = document.createElement("div");
    thumb.className = "c3d-thumb";

    const empty = document.createElement("div");
    empty.className = "c3d-thumb-empty";
    empty.innerHTML = `<div class="icon">◇</div><div class="label">empty scene</div>`;
    thumb.appendChild(empty);

    const status = document.createElement("div");
    status.className = "c3d-status";
    status.textContent = "no render yet";
    thumb.appendChild(status);

    const editBtn = document.createElement("button");
    editBtn.className = "c3d-edit-btn";
    editBtn.textContent = "⛶  Edit Scene";

    wrap.appendChild(thumb);
    wrap.appendChild(editBtn);

    return { wrap, thumb, empty, status, editBtn };
}


async function refreshThumbnail(node, ui) {
    const nodeId = String(node.id);
    try {
        const [vr, ir] = await Promise.all([
            fetch(`/comfyblockout/video_url?node_id=${nodeId}`).then(r => r.json()),
            fetch(`/comfyblockout/image_url?node_id=${nodeId}`).then(r => r.json()),
        ]);

        const videoUrl = vr.url ? `${vr.url}?t=${Date.now()}` : null;
        const imageUrl = ir.url ? `${ir.url}?t=${Date.now()}` : null;

        if (videoUrl) {
            ui.empty.style.display = "none";
            const img = ui.thumb.querySelector("img");
            if (img) img.remove();
            let video = ui.thumb.querySelector("video");
            if (!video) {
                video = document.createElement("video");
                video.muted = true;
                video.loop = true;
                video.autoplay = true;
                video.playsInline = true;
                ui.thumb.insertBefore(video, ui.status);
            }
            if (!video.src.endsWith(videoUrl)) {
                video.src = videoUrl;
                video.play().catch(() => {});
            }
            ui.status.textContent = imageUrl ? "rendered · snapshot + video" : "rendered · loop preview";
        } else if (imageUrl) {
            ui.empty.style.display = "none";
            const video = ui.thumb.querySelector("video");
            if (video) video.remove();
            let img = ui.thumb.querySelector("img");
            if (!img) {
                img = document.createElement("img");
                img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
                ui.thumb.insertBefore(img, ui.status);
            }
            if (!img.src.endsWith(imageUrl)) img.src = imageUrl;
            ui.status.textContent = "snapshot only";
        } else {
            ui.empty.style.display = "flex";
            ui.thumb.querySelector("video")?.remove();
            ui.thumb.querySelector("img")?.remove();
            ui.status.textContent = "no render yet";
        }
    } catch (e) {
        console.warn("[Comfy3D] thumbnail refresh failed:", e);
    }
}


function openEditor(node) {
    const nodeId = String(node.id);
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

        node.addDOMWidget("preview", "div", ui.wrap, {
            serialize: false,
            getHeight: () => 220,
        });

        ui.editBtn.addEventListener("click", () => openEditor(node));

        node.__c3dRefresh = () => refreshThumbnail(node, ui);
        node.__c3dRefresh();

        const origSize = node.size?.slice();
        if (origSize && origSize[1] < 280) node.size[1] = 280;
        if (origSize && origSize[0] < 240) node.size[0] = 240;
    },
});

console.log("[Comfy3D] extension loaded");
