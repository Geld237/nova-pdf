/**
 * Connexion directe entre deux appareils (WebRTC), sans serveur ni compte.
 * Les deux appareils s'échangent un code de connexion (QR code ou texte).
 * Les données transitent chiffrées (DTLS) directement d'un appareil à l'autre.
 */
export type Msg = { type: string; [k: string]: unknown };

const CHUNK = 48 * 1024;

async function pack(obj: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cs = new CompressionStream('deflate-raw');
  const buf = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer());
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return 'NOVA1.' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function unpack<T>(code: string): Promise<T> {
  const raw = code.trim().replace(/^.*?NOVA1\./s, '').replace(/\s/g, '');
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const ds = new DecompressionStream('deflate-raw');
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
  return JSON.parse(text);
}

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class Peer {
  pc: RTCPeerConnection;
  ch: RTCDataChannel | null = null;
  private handlers = new Set<(m: Msg) => void>();
  private stateHandlers = new Set<(s: string) => void>();
  private incoming = new Map<string, { meta: Msg; parts: string[]; total: number }>();
  remoteName = '';

  constructor(useStun: boolean) {
    this.pc = new RTCPeerConnection({ iceServers: useStun ? [{ urls: 'stun:stun.l.google.com:19302' }] : [] });
    this.pc.onconnectionstatechange = () => this.stateHandlers.forEach((h) => h(this.pc.connectionState));
    this.pc.ondatachannel = (e) => this.bind(e.channel);
  }

  private bind(ch: RTCDataChannel) {
    this.ch = ch;
    ch.bufferedAmountLowThreshold = 256 * 1024;
    ch.onopen = () => this.stateHandlers.forEach((h) => h('open'));
    ch.onclose = () => this.stateHandlers.forEach((h) => h('closed'));
    ch.onmessage = (e) => {
      const m = JSON.parse(e.data) as Msg;
      if (m.type === '__chunk') {
        const f = this.incoming.get(m.id as string);
        if (!f) return;
        f.parts[m.seq as number] = m.data as string;
        if (f.parts.filter(Boolean).length === f.total) {
          this.incoming.delete(m.id as string);
          const bytes = unb64(f.parts.join(''));
          this.emit({ ...f.meta, bytes });
        } else this.emit({ type: '__progress', id: m.id, done: f.parts.filter(Boolean).length, total: f.total });
        return;
      }
      if (m.type === '__file') {
        this.incoming.set(m.id as string, { meta: m.meta as Msg, parts: [], total: m.total as number });
        if (!(m.total as number)) this.emit({ ...(m.meta as Msg), bytes: new Uint8Array() });
        return;
      }
      if (m.type === 'hello') this.remoteName = String(m.name ?? '');
      this.emit(m);
    };
  }

  private emit(m: Msg) {
    this.handlers.forEach((h) => h(m));
  }

  on(h: (m: Msg) => void): () => void {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  onState(h: (s: string) => void): () => void {
    this.stateHandlers.add(h);
    return () => {
      this.stateHandlers.delete(h);
    };
  }

  get open() {
    return this.ch?.readyState === 'open';
  }

  send(m: Msg) {
    if (this.open) this.ch!.send(JSON.stringify(m));
  }

  private async drain() {
    const ch = this.ch!;
    if (ch.bufferedAmount < 1024 * 1024) return;
    await new Promise<void>((r) => {
      ch.onbufferedamountlow = () => {
        ch.onbufferedamountlow = null;
        r();
      };
    });
  }

  /** Envoie un message accompagné d'un fichier binaire (découpé en morceaux). */
  async sendFile(meta: Msg, bytes: Uint8Array) {
    const data = b64(bytes);
    const id = Math.random().toString(36).slice(2);
    const total = Math.ceil(data.length / CHUNK);
    this.send({ type: '__file', id, total, meta });
    for (let i = 0; i < total; i++) {
      await this.drain();
      this.send({ type: '__chunk', id, seq: i, data: data.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
  }

  private async gathered() {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise<void>((r) => {
      const t = setTimeout(r, 4000);
      this.pc.addEventListener('icegatheringstatechange', () => {
        if (this.pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          r();
        }
      });
    });
  }

  /** Appareil A : crée le code d'invitation. */
  async createOffer(): Promise<string> {
    this.bind(this.pc.createDataChannel('nova', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gathered();
    return pack({ t: 'o', sdp: this.pc.localDescription!.sdp });
  }

  /** Appareil B : lit l'invitation et produit le code de réponse. */
  async acceptOffer(code: string): Promise<string> {
    const { t, sdp } = await unpack<{ t: string; sdp: string }>(code);
    if (t !== 'o') throw new Error("Ce code n'est pas une invitation.");
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gathered();
    return pack({ t: 'a', sdp: this.pc.localDescription!.sdp });
  }

  /** Appareil A : lit la réponse ; la connexion s'établit. */
  async acceptAnswer(code: string) {
    const { t, sdp } = await unpack<{ t: string; sdp: string }>(code);
    if (t !== 'a') throw new Error("Ce code n'est pas une réponse.");
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  close() {
    this.ch?.close();
    this.pc.close();
  }
}

/** Session partagée par toute l'application (un pair à la fois). */
export const session: { peer: Peer | null; listeners: Set<() => void> } = { peer: null, listeners: new Set() };
export const setSessionPeer = (p: Peer | null) => {
  session.peer?.close();
  session.peer = p;
  session.listeners.forEach((l) => l());
};
