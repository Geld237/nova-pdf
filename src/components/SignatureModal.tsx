import { useEffect, useRef, useState } from 'react';
import { loadSignatures, saveSignatures } from '../memory';

/** Création / choix d'une signature : tracé, texte manuscrit ou image. */
export function SignatureModal({ onPick, onClose }: { onPick: (dataUrl: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<'draw' | 'type' | 'image'>('draw');
  const [saved, setSaved] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [color, setColor] = useState('#1a237e');
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    loadSignatures().then(setSaved);
  }, []);

  const ctx = () => canvas.current!.getContext('2d')!;
  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.current!.width) / r.width, ((e.clientY - r.top) * canvas.current!.height) / r.height];
  };

  const finish = async (dataUrl: string) => {
    const next = [dataUrl, ...saved.filter((s) => s !== dataUrl)].slice(0, 6);
    await saveSignatures(next);
    onPick(dataUrl);
  };

  const fromTyped = () => {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 160;
    const g = c.getContext('2d')!;
    g.fillStyle = color;
    g.font = 'italic 72px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive';
    g.textBaseline = 'middle';
    g.fillText(typed, 20, 85);
    return trim(c);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Signature">
        <header className="panel-head">
          <h2>Signature</h2>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </header>
        {saved.length > 0 && (
          <div className="saved-sigs">
            {saved.map((s) => (
              <div key={s} className="saved-sig">
                <button onClick={() => onPick(s)}>
                  <img src={s} alt="Signature enregistrée" />
                </button>
                <button
                  className="icon"
                  title="Oublier"
                  onClick={async () => {
                    const n = saved.filter((x) => x !== s);
                    setSaved(n);
                    await saveSignatures(n);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="seg">
          {(['draw', 'type', 'image'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {{ draw: 'Dessiner', type: 'Écrire', image: 'Image' }[m]}
            </button>
          ))}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Couleur" />
        </div>
        {mode === 'draw' && (
          <>
            <canvas
              ref={canvas}
              width={600}
              height={200}
              className="sig-pad"
              onPointerDown={(e) => {
                drawing.current = true;
                const [x, y] = pos(e);
                const g = ctx();
                g.strokeStyle = color;
                g.lineWidth = 3;
                g.lineCap = 'round';
                g.lineJoin = 'round';
                g.beginPath();
                g.moveTo(x, y);
                (e.target as Element).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return;
                const [x, y] = pos(e);
                ctx().lineTo(x, y);
                ctx().stroke();
                setHasInk(true);
              }}
              onPointerUp={() => (drawing.current = false)}
            />
            <div className="row">
              <button
                onClick={() => {
                  ctx().clearRect(0, 0, 600, 200);
                  setHasInk(false);
                }}
              >
                Effacer
              </button>
              <button className="primary" disabled={!hasInk} onClick={() => finish(trim(canvas.current!))}>
                Utiliser
              </button>
            </div>
          </>
        )}
        {mode === 'type' && (
          <>
            <input className="typed-sig" style={{ color }} placeholder="Votre nom" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button className="primary" disabled={!typed.trim()} onClick={() => finish(fromTyped())}>
              Utiliser
            </button>
          </>
        )}
        {mode === 'image' && (
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = new FileReader();
              r.onload = () => {
                const img = new Image();
                img.onload = () => {
                  const c = document.createElement('canvas');
                  c.width = img.width;
                  c.height = img.height;
                  c.getContext('2d')!.drawImage(img, 0, 0);
                  finish(c.toDataURL('image/png'));
                };
                img.src = String(r.result);
              };
              r.readAsDataURL(f);
            }}
          />
        )}
        <p className="muted">Ensuite, cliquez sur la page pour placer la signature. Elle reste enregistrée sur cet appareil.</p>
      </div>
    </div>
  );
}

/** Rogne les bords transparents d'un canvas. */
function trim(c: HTMLCanvasElement): string {
  const g = c.getContext('2d')!;
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 10) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
  if (x1 <= x0) return c.toDataURL('image/png');
  const pad = 6;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + pad * 2;
  out.height = y1 - y0 + pad * 2;
  out.getContext('2d')!.drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
