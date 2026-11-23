"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ALLOWED_TYPES, MAX_BYTES } from "@/lib/images";

type Img = { key: string; name: string; url: string; size: number; uploaded: string };
type Job = { id: string; name: string; progress: number; status: "working" | "done" | "error"; message?: string };

const MAX_WIDTH = 1200; // 2x a 600px email column: sharp on retina screens, still small

const kb = (n: number) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Shrinks big photos before upload so emails load fast. GIFs are left alone (they may be animated).
 * WebP is converted, because some Outlook versions can't show it.
 */
async function prepare(file: File): Promise<{ blob: Blob; type: string; name: string }> {
  if (file.type === "image/gif") return { blob: file, type: file.type, name: file.name };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_WIDTH / bmp.width);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);

  // Keep PNG only when the image really uses transparency (logos); photos become JPG.
  let transparent = false;
  if (file.type === "image/png" || file.type === "image/webp") {
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < px.length; i += 4 * 7) if (px[i] < 250) { transparent = true; break; }
  }
  const type = transparent ? "image/png" : "image/jpeg";
  if (!transparent) {
    // Paint onto white so any near-transparent edges don't turn black in JPG.
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  const blob: Blob = await new Promise((ok, no) => canvas.toBlob(b => (b ? ok(b) : no(new Error("Couldn’t process image"))), type, 0.85));
  // If our version isn't smaller and wasn't resized, upload the original.
  if (scale === 1 && blob.size >= file.size && file.type === type) return { blob: file, type, name: file.name };
  return { blob, type, name: file.name.replace(/\.[a-z0-9]+$/i, "") + (type === "image/png" ? ".png" : ".jpg") };
}

function postToS3(url: string, fields: Record<string, string>, blob: Blob, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    form.append("file", blob); // must be the last field
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Storage refused the upload (" + xhr.status + ")")));
    xhr.onerror = () => reject(new Error("Network error while uploading"));
    xhr.send(form);
  });
}

export default function ContentLibrary() {
  const [images, setImages] = useState<Img[] | null>(null);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [q, setQ] = useState("");
  const [drag, setDrag] = useState(false);
  const [toast, setToast] = useState("");
  const [confirm, setConfirm] = useState<Img | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2800);
  };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/images", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn’t load images");
      setImages(j.images);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setImages([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = (id: string, patch: Partial<Job>) => setJobs(js => js.map(j => (j.id === id ? { ...j, ...patch } : j)));

  async function uploadOne(file: File) {
    const id = crypto.randomUUID();
    setJobs(js => [{ id, name: file.name, progress: 0, status: "working" }, ...js]);
    try {
      if (!ALLOWED_TYPES[file.type]) {
        throw new Error(/heic|heif/i.test(file.type + file.name) ? "iPhone HEIC photos aren’t supported in email. Export it as JPG first." : "Only JPG, PNG, GIF and WebP images.");
      }
      const prepared = await prepare(file);
      if (prepared.blob.size > MAX_BYTES) throw new Error("Still over 10 MB after shrinking. Try a smaller file.");
      const r = await fetch("/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: prepared.name, type: prepared.type, size: prepared.blob.size }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn’t start the upload");
      await postToS3(j.upload.url, j.upload.fields, prepared.blob, p => update(id, { progress: p }));
      update(id, { status: "done", progress: 1, message: kb(prepared.blob.size) + (prepared.blob !== file ? " after shrinking" : "") });
      return true;
    } catch (e) {
      update(id, { status: "error", message: (e as Error).message });
      return false;
    }
  }

  async function handleFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (!files.length) return;
    const results = await Promise.all(files.map(uploadOne));
    const ok = results.filter(Boolean).length;
    if (ok) flash(`${ok} image${ok > 1 ? "s" : ""} uploaded`);
    load();
  }

  async function copy(text: string, msg: string) {
    try {
      await navigator.clipboard.writeText(text);
      flash(msg);
    } catch {
      window.prompt("Copy this:", text);
    }
  }

  async function doDelete(img: Img) {
    setConfirm(null);
    const r = await fetch("/api/images/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: img.key }) });
    if (r.ok) {
      setImages(xs => (xs || []).filter(x => x.key !== img.key));
      flash("Image deleted");
    } else flash("Couldn’t delete that image");
  }

  const shown = (images || []).filter(i => i.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div
      className="content"
      onDragOver={e => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={e => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={e => {
        e.preventDefault();
        setDrag(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="page-h">
        <div>
          <h1>Content library</h1>
          <div className="sub">
            {images ? `${images.length} image${images.length === 1 ? "" : "s"}` : "Loading…"} · stored in your AWS account and served from a public link, so they show up in every inbox.
          </div>
        </div>
        <div className="flex">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden onChange={e => e.target.files && handleFiles(e.target.files)} />
          <button className="btn pri" onClick={() => input.current?.click()}>
            ⇪ Upload images
          </button>
        </div>
      </div>

      <div className="notice warn">Anyone with the link can see an uploaded image. Never upload anything showing patient or confidential information.</div>
      {error && <div className="notice err">{error}</div>}

      <div className={"drop" + (drag ? " over" : "")} onClick={() => input.current?.click()}>
        <b>Drag images here</b> or click to choose. JPG, PNG, GIF or WebP. Big photos are shrunk to 1200px wide automatically.
      </div>

      {jobs.length > 0 && (
        <div className="card mb">
          <div className="card-h">
            <h3>Uploads</h3>
            <button className="btn sm ghost" onClick={() => setJobs(js => js.filter(j => j.status === "working"))}>
              Clear finished
            </button>
          </div>
          {jobs.map(j => (
            <div key={j.id} className="job">
              <div className="flex between">
                <span>{j.name}</span>
                <span className={"small " + (j.status === "error" ? "err-t" : "muted")}>
                  {j.status === "working" ? Math.round(j.progress * 100) + "%" : j.status === "done" ? "✓ Uploaded" + (j.message ? " · " + j.message : "") : j.message}
                </span>
              </div>
              {j.status === "working" && (
                <div className="bar">
                  <i style={{ width: `${Math.max(4, j.progress * 100)}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card mb">
        <div className="toolbar">
          <input type="search" placeholder="Search images" value={q} onChange={e => setQ(e.target.value)} aria-label="Search images" />
          <button className="btn sm ghost" onClick={load}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {images && shown.length === 0 && !error && <div className="card empty">{q ? "No images match." : "No images yet. Upload your first one above."}</div>}

      <div className="grid g4">
        {shown.map(img => (
          <div key={img.key} className="card img-card">
            <div className="thumb">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.name} loading="lazy" />
            </div>
            <div className="card-b">
              <div className="name" title={img.name}>
                {img.name}
              </div>
              <div className="small muted">
                {kb(img.size)} · {day(img.uploaded)}
              </div>
              <div className="flex wrap mt">
                <button className="btn sm" onClick={() => copy(img.url, "Image link copied")}>
                  Copy link
                </button>
                <button className="btn sm" onClick={() => copy(`<img src="${img.url}" alt="" width="600" style="display:block;max-width:100%;height:auto;border:0;">`, "Image HTML copied")}>
                  Copy HTML
                </button>
                <button className="btn sm ghost danger" onClick={() => setConfirm(img)} aria-label={"Delete " + img.name}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {confirm && (
        <div className="modal-bg" onClick={e => e.target === e.currentTarget && setConfirm(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-h">
              <h3>Delete {confirm.name}?</h3>
            </div>
            <div className="modal-b">Emails that already used this image will show a broken image. This can’t be undone.</div>
            <div className="modal-f">
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => doDelete(confirm)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
