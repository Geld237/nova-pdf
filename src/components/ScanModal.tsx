import { useEffect, useRef, useState } from 'react';
import { applyFilter, detectQuad, fileToCanvas, warp, type Quad, type ScanFilter } from '../scan';
import { imagesToPdf } from '../pdf/tools';

/** Scanner : photo → détection des bords → coins ajustables → redressement → filtre → PDF. */
export function ScanModal({ onDone, onClose }: { onDone: (pdf: Uint8Array) => void; onClose: () => void }) {
  const [pages, setPages] = useState<string[]>([]); // data URL JPEG
  const [src, setSrc] = useState<HTMLCanvasElement | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [filter, setFilter] = useState<ScanFilter>('color');
  const [preview, setPreview] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const box = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);

  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);

  const load = async (c: HTMLCanvasElement) => {
    setSrc(c);
    setQuad(detectQuad(c));
    setPreview(null);
  };

  const pick = (capture: boolean) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'image/*';
    if (capture) i.setAttribute('capture', 'environment');
    i.onchange = async () => i.files?.[0] && load(await fileToCanvas(i.files[0]));
    i.click();
  };

  const startCamera = async () => {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } } });
      setCamera(true);
      requestAnimationFrame(() => {
        if (video.current) {
          video.current.srcObject = stream.current;
          video.current.play();
        }
      });
    } catch {
      pick(true);
    }
  };

  const snap = () => {
    const v = video.current!;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    stream.current?.getTracks().forEach((t) => t.stop());
    setCamera(false);
    load(c);
  };

  const process = async (): Promise<string> => {
    const out = applyFilter(warp(src!, quad!), filter);
    return out.toDataURL('image/jpeg', filter === 'bw' ? 0.8 : 0.85);
  };

  useEffect(() => {
    if (!src || !quad) return;
    const t = setTimeout(async () => setPreview(await process()), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, quad, filter]);

  const svgPoint = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * src!.width, ((e.clientY - r.top) / r.height) * src!.height] as [number, number];
  };

  const finish = async () => {
    setBusy(true);
    const files = await Promise.all(
      pages.map(async (d, i) => new File([await (await fetch(d)).blob()], `scan-${i + 1}.jpg`, { type: 'image/jpeg' })),
    );
    onDone(await imagesToPdf(files));
    setBusy(false);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal scan-modal" role="dialog" aria-label="Scanner">
        <header className="panel-head">
          <h2>📷 Scanner un document</h2>
          <button className="icon" onClick={onClose}>✕</button>
        </header>

        {camera && (
          <div className="scan-camera">
            <video ref={video} playsInline muted />
            <button className="primary big" onClick={snap}>◉ Capturer</button>
          </div>
        )}

        {!camera && !src && (
          <div className="col">
            <button className="primary big" onClick={startCamera}>Utiliser la caméra</button>
            <button onClick={() => pick(false)}>Choisir une photo…</button>
            <p className="muted">Posez la feuille sur un fond contrasté. Les bords sont détectés automatiquement, vous pouvez les ajuster.</p>
          </div>
        )}

        {src && quad && (
          <div className="scan-edit">
            <div className="scan-stage">
              <img src={src.toDataURL('image/jpeg', 0.7)} alt="Photo" />
              <svg
                ref={box}
                viewBox={`0 0 ${src.width} ${src.height}`}
                preserveAspectRatio="none"
                onPointerMove={(e) => {
                  if (drag.current === null) return;
                  const q = [...quad] as Quad;
                  q[drag.current] = svgPoint(e);
                  setQuad(q);
                }}
                onPointerUp={() => (drag.current = null)}
              >
                <polygon points={quad.map((p) => p.join(',')).join(' ')} fill="rgb(61 82 213 / 0.15)" stroke="#3d52d5" strokeWidth={src.width / 300} />
                {quad.map((p, i) => (
                  <circle
                    key={i}
                    cx={p[0]}
                    cy={p[1]}
                    r={src.width / 45}
                    fill="#fff"
                    stroke="#3d52d5"
                    strokeWidth={src.width / 250}
                    style={{ cursor: 'grab', touchAction: 'none' }}
                    onPointerDown={(e) => {
                      drag.current = i;
                      (e.target as Element).setPointerCapture(e.pointerId);
                    }}
                  />
                ))}
              </svg>
            </div>
            <div className="scan-side">
              <div className="seg">
                {(['color', 'gray', 'bw'] as const).map((f) => (
                  <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                    {{ color: 'Couleur', gray: 'Gris', bw: 'Noir & blanc' }[f]}
                  </button>
                ))}
              </div>
              {preview ? <img className="scan-preview" src={preview} alt="Aperçu redressé" /> : <p className="muted">Redressement…</p>}
              <div className="row">
                <button onClick={() => setQuad(detectQuad(src))}>Détecter à nouveau</button>
                <button onClick={() => setQuad([[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]])}>Image entière</button>
              </div>
              <button
                className="primary"
                onClick={async () => {
                  setPages([...pages, preview ?? (await process())]);
                  setSrc(null);
                  setQuad(null);
                  setPreview(null);
                }}
              >
                ✓ Ajouter cette page
              </button>
            </div>
          </div>
        )}

        {pages.length > 0 && (
          <>
            <div className="scan-pages">
              {pages.map((p, i) => (
                <div key={i}>
                  <img src={p} alt={`Page ${i + 1}`} />
                  <button className="icon" onClick={() => setPages(pages.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>
            <div className="row">
              {!src && !camera && <button onClick={startCamera}>+ Page suivante</button>}
              <button className="primary" disabled={busy} onClick={finish}>
                Créer le PDF ({pages.length} page{pages.length > 1 ? 's' : ''})
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

