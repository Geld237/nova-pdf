import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Peer, session, setSessionPeer, type Msg } from '../p2p';
import { handleSyncMessage, sendManifest } from '../sync';
import { listSigRequests, markSigRequest, signRequests, type SigRequest } from '../pdf/sigreq';
import { baseName } from '../pdf/tools';
import { saveFile, isNative, platformName } from '../platform';
import { loadProfile } from '../profile';
import type { DocCtx } from './ToolsPanel';
import type { Annotation } from '../types';

interface Props {
  ctx: DocCtx | null;
  fingerprint?: string;
  annotations: Annotation[];
  onSignatureFieldTool: (signer: string) => void;
  pickSignature: () => Promise<string | null>;
}

type Tab = 'connect' | 'sync' | 'review' | 'sign';

export function SharePanel(p: Props) {
  const [tab, setTab] = useState<Tab>('connect');
  const [, force] = useState(0);
  useEffect(() => {
    let offMsg: (() => void) | undefined;
    const l = () => {
      force((n) => n + 1);
      offMsg?.();
      offMsg = session.peer?.on((m) => m.type === 'hello' && force((n) => n + 1));
    };
    l();
    session.listeners.add(l);
    return () => {
      offMsg?.();
      session.listeners.delete(l);
    };
  }, []);
  const connected = !!session.peer?.open;

  return (
    <div className="panel share-panel">
      <header className="panel-head">
        <h2>Partager</h2>
        {connected && <small className="ok-badge">● connecté{session.peer?.remoteName ? ` à ${session.peer.remoteName}` : ''}</small>}
      </header>
      <div className="seg wrap">
        <button className={tab === 'connect' ? 'active' : ''} onClick={() => setTab('connect')}>Connexion</button>
        <button className={tab === 'sync' ? 'active' : ''} onClick={() => setTab('sync')}>Synchroniser</button>
        <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>Relire ensemble</button>
        <button className={tab === 'sign' ? 'active' : ''} onClick={() => setTab('sign')}>Signatures</button>
      </div>
      {tab === 'connect' && <Connect onConnected={() => setTab('sync')} />}
      {tab === 'sync' && (connected ? <Sync /> : <NeedConnection go={() => setTab('connect')} />)}
      {tab === 'review' && (connected ? <Review ctx={p.ctx} annotations={p.annotations} /> : <NeedConnection go={() => setTab('connect')} />)}
      {tab === 'sign' && <Sign {...p} connected={connected} />}
    </div>
  );
}

function NeedConnection({ go }: { go: () => void }) {
  return (
    <p className="empty">
      Connectez d'abord l'autre appareil. <button className="link" onClick={go}>Se connecter</button>
    </p>
  );
}

/* ----- Connexion par QR code ------------------------------------------------- */

function Connect({ onConnected }: { onConnected: () => void }) {
  const [role, setRole] = useState<'host' | 'guest' | null>(null);
  const [code, setCode] = useState('');
  const [qr, setQr] = useState('');
  const [input, setInput] = useState('');
  const [state, setState] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const [stun, setStun] = useState(true);

  const show = async (c: string) => {
    setCode(c);
    setQr(await QRCode.toDataURL(c, { errorCorrectionLevel: 'L', margin: 1, width: 300 }));
  };

  const wire = (peer: Peer) => {
    peer.onState((s) => {
      setState(s);
      if (s === 'open') {
        peer.send({ type: 'hello', name: `${loadProfile().prenom || 'Appareil'} (${platformName()})` });
        setSessionPeer(peer);
        onConnected();
      }
      if (s === 'failed' || s === 'closed') session.listeners.forEach((l) => l());
    });
  };

  const host = async () => {
    setError(null);
    setRole('host');
    const peer = new Peer(stun);
    wire(peer);
    (window as unknown as { __novaPending?: Peer }).__novaPending = peer;
    setState('Préparation…');
    await show(await peer.createOffer());
    setState('En attente de la réponse');
  };

  const submit = async (value: string) => {
    setError(null);
    setScan(false);
    try {
      if (role === 'host') {
        await (window as unknown as { __novaPending: Peer }).__novaPending.acceptAnswer(value);
        setState('Connexion…');
      } else {
        const peer = new Peer(stun);
        wire(peer);
        setState('Préparation de la réponse…');
        await show(await peer.acceptOffer(value));
        setState('Montrez ce code au premier appareil');
      }
    } catch (e) {
      setError(`Code invalide : ${(e as Error).message}`);
    }
  };

  if (session.peer?.open)
    return (
      <div className="col">
        <p>✓ Connecté{session.peer.remoteName ? ` à ${session.peer.remoteName}` : ''}. Les données passent directement d'un appareil à l'autre, chiffrées.</p>
        <button onClick={() => setSessionPeer(null)}>Se déconnecter</button>
      </div>
    );

  return (
    <div className="col">
      <p className="muted">Reliez deux appareils sans compte ni serveur : l'un affiche un code, l'autre le scanne, puis inversement.</p>
      {!role && (
        <>
          <button className="primary" onClick={host}>1. Inviter un appareil (afficher un code)</button>
          <button onClick={() => setRole('guest')}>2. Rejoindre (scanner le code de l'autre)</button>
          <label className="check">
            <input type="checkbox" checked={stun} onChange={(e) => setStun(e.target.checked)} /> Autoriser la connexion par Internet (sinon : même réseau Wi-Fi uniquement)
          </label>
        </>
      )}
      {qr && (
        <div className="qr-box">
          <img src={qr} alt="Code de connexion" />
          <textarea className="code-text" readOnly rows={2} value={code} onFocus={(e) => e.target.select()} />
          <div className="row">
            <button onClick={() => navigator.clipboard?.writeText(code)}>Copier le code</button>
            {'share' in navigator && <button onClick={() => navigator.share({ text: code }).catch(() => {})}>Partager…</button>}
          </div>
        </div>
      )}
      {role && (role === 'guest' ? !qr : !!qr) && (
        <>
          <b>{role === 'host' ? "Scannez le code de réponse de l'autre appareil :" : "Scannez le code d'invitation :"}</b>
          {scan ? <QrScanner onCode={submit} onCancel={() => setScan(false)} /> : <button onClick={() => setScan(true)}>📷 Scanner avec la caméra</button>}
          <textarea rows={3} placeholder="…ou collez le code ici (NOVA1.…)" value={input} onChange={(e) => setInput(e.target.value)} />
          <button disabled={!input.trim()} onClick={() => submit(input)}>Valider le code</button>
        </>
      )}
      {state && <p className="muted">État : {state}</p>}
      {error && <p className="error">{error}</p>}
      {role && <button className="link" onClick={() => { setRole(null); setQr(''); setCode(''); setInput(''); setState(''); }}>Recommencer</button>}
    </div>
  );
}

function QrScanner({ onCode, onCancel }: { onCode: (c: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let done = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const BD = (window as unknown as { BarcodeDetector?: new (o: unknown) => { detect: (s: unknown) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        const detector = BD ? new BD({ formats: ['qr_code'] }) : null;
        const jsQR = detector ? null : (await import('jsqr')).default;
        const c = document.createElement('canvas');
        const tick = async () => {
          if (done) return;
          if (v.videoWidth) {
            let value: string | null = null;
            if (detector) value = (await detector.detect(v).catch(() => []))[0]?.rawValue ?? null;
            else {
              c.width = v.videoWidth;
              c.height = v.videoHeight;
              const g = c.getContext('2d', { willReadFrequently: true })!;
              g.drawImage(v, 0, 0);
              value = jsQR!(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height)?.data ?? null;
            }
            if (value?.includes('NOVA1.')) {
              done = true;
              onCode(value);
              return;
            }
          }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      } catch {
        setErr('Caméra indisponible : collez le code à la place.');
      }
    })();
    return () => {
      done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);
  return (
    <div className="qr-scan">
      {err ? <p className="error">{err}</p> : <video ref={video} playsInline muted />}
      <button onClick={onCancel}>Annuler</button>
    </div>
  );
}

/* ----- Synchronisation --------------------------------------------------------- */

function Sync() {
  const [log, setLog] = useState<string[]>([]);
  const [sent, setSent] = useState(0);
  const [received, setReceived] = useState(0);
  useEffect(() => {
    const peer = session.peer!;
    return peer.on(async (m: Msg) => {
      if (m.type === '__progress') return;
      const handled = await handleSyncMessage(peer, m, (pr) => {
        if (pr.status) setLog((l) => [...l.slice(-30), pr.status!]);
        if (pr.sent) setSent(pr.sent);
      });
      if (handled && m.type === 'lib-file') setReceived((n) => n + 1);
    });
  }, []);
  return (
    <div className="col">
      <p className="muted">Fusionne la bibliothèque, les annotations, les notes et les fiches de révision des deux appareils.</p>
      <button className="primary" onClick={() => { setLog(['Synchronisation…']); sendManifest(session.peer!); }}>Synchroniser maintenant</button>
      <p className="muted">{sent} document(s) envoyé(s) · {received} reçu(s)</p>
      <div className="sync-log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
    </div>
  );
}

/* ----- Relecture à plusieurs ------------------------------------------------- */

function Review({ ctx, annotations }: { ctx: DocCtx | null; annotations: Annotation[] }) {
  const [chat, setChat] = useState<{ from: string; text: string }[]>([]);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    return session.peer!.on((m) => {
      if (m.type === 'chat') setChat((c) => [...c, { from: String(m.from), text: String(m.text) }]);
    });
  }, []);
  const me = loadProfile().prenom || 'Moi';
  return (
    <div className="col">
      <p className="muted">
        Envoyez le document à l'autre appareil : chaque surlignage, note ou dessin ajouté d'un côté apparaît de l'autre en direct.
      </p>
      <button
        className="primary"
        disabled={!ctx}
        onClick={async () => {
          if (!ctx) return;
          await session.peer!.sendFile({ type: 'review-open', name: ctx.name, annotations }, await ctx.getBytesRaw());
          ctx.markReview();
          ctx.notify('Document partagé en relecture.');
        }}
      >
        Partager le document en relecture
      </button>
      <div className="review-chat">
        {chat.map((c, i) => (
          <div key={i} className={`msg ${c.from === me ? 'user' : 'assistant'}`}>
            <b>{c.from} :</b> {c.text}
          </div>
        ))}
      </div>
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          if (!msg.trim()) return;
          session.peer!.send({ type: 'chat', from: me, text: msg });
          setChat((c) => [...c, { from: me, text: msg }]);
          setMsg('');
        }}
      >
        <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message aux relecteurs…" style={{ flex: 1 }} />
        <button type="submit">Envoyer</button>
      </form>
    </div>
  );
}

/* ----- Demandes de signature ------------------------------------------------- */

function Sign({ ctx, onSignatureFieldTool, pickSignature, connected }: Props & { connected: boolean }) {
  const prof = loadProfile();
  const [signer, setSigner] = useState('');
  const [from, setFrom] = useState(`${prof.prenom} ${prof.nom}`.trim());
  const [message, setMessage] = useState('Merci de signer ce document.');
  const [reqs, setReqs] = useState<{ requests: SigRequest[]; from: string; message: string } | null>(null);
  const [me, setMe] = useState(`${prof.prenom} ${prof.nom}`.trim());
  const [signed, setSigned] = useState(false);

  useEffect(() => {
    if (!ctx) return;
    ctx.getBytesRaw().then(listSigRequests).then(setReqs).catch(() => setReqs(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.pdf]);

  if (!ctx) return <p className="empty">Ouvrez un document.</p>;

  const send = async (bytes: Uint8Array, name: string) => {
    if (connected) {
      await session.peer!.sendFile({ type: 'sig-file', name }, bytes);
      ctx.notify("Envoyé à l'appareil connecté.");
      return;
    }
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    const file = new File([bytes as BlobPart], name, { type: 'application/pdf' });
    if (!isNative && nav.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name, text: message }).catch(() => {});
    } else await saveFile(bytes, name);
  };

  return (
    <div className="col">
      {reqs && reqs.requests.length > 0 && (
        <div className="update-box">
          <b>✍ Ce document attend {reqs.requests.length} signature(s)</b>
          {reqs.from && <small>De : {reqs.from}</small>}
          {reqs.message && <small>« {reqs.message} »</small>}
          <ul className="att-list">
            {reqs.requests.map((r, i) => (
              <li key={i}><span>{r.signer}</span><small>p. {r.page + 1}</small></li>
            ))}
          </ul>
          <label>Votre nom <input value={me} onChange={(e) => setMe(e.target.value)} /></label>
          <button
            className="primary"
            disabled={!me.trim()}
            onClick={async () => {
              const sig = await pickSignature();
              if (!sig) return;
              const out = await signRequests(await ctx.getBytes(), sig, me.trim());
              await ctx.replace(out, 'Document signé');
              setReqs(await listSigRequests(out));
              setSigned(true);
            }}
          >
            Signer maintenant
          </button>
          <button onClick={async () => send(await ctx.getBytes(), `${baseName(ctx.name)}-signe.pdf`)}>
            {connected ? "Renvoyer à l'appareil connecté" : 'Renvoyer le document signé…'}
          </button>
        </div>
      )}

      {signed && !reqs?.requests.length && (
        <div className="update-box">
          <b>✓ Document signé</b>
          <button className="primary" onClick={async () => send(await ctx.getBytes(), `${baseName(ctx.name)}-signe.pdf`)}>
            {connected ? "Renvoyer à l'appareil connecté" : 'Renvoyer le document signé…'}
          </button>
        </div>
      )}

      <h3 className="group">Demander une signature</h3>
      <label>Signataire <input value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="ex. Marie Dupont" /></label>
      <button disabled={!signer.trim()} onClick={() => onSignatureFieldTool(signer.trim())}>
        1. Dessiner l'emplacement de sa signature sur la page
      </button>
      <label>Votre nom <input value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>Message <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
      <button
        className="primary"
        onClick={async () => {
          const bytes = await markSigRequest(await ctx.getBytes(), from, message);
          const found = await listSigRequests(bytes);
          if (!found.requests.length) {
            ctx.notify("Ajoutez d'abord au moins un emplacement de signature (étape 1).");
            return;
          }
          await send(bytes, `${baseName(ctx.name)}-a-signer.pdf`);
        }}
      >
        2. {connected ? "Envoyer à l'appareil connecté" : 'Envoyer (partage, e-mail, fichier)'}
      </button>
      <p className="muted small">
        Le destinataire ouvre le PDF dans Nova PDF (web, ordinateur ou mobile), signe, et vous le renvoie. Signature simple (image + date), pas une signature
        qualifiée eIDAS.
      </p>
    </div>
  );
}
