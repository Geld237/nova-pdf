import { useEffect, useRef, useState } from 'react';

/**
 * Boîtes de dialogue intégrées (remplacent alert / confirm / prompt du navigateur,
 * qui ne s'affichent pas dans toutes les applications de bureau ou mobiles).
 */
type Req =
  | { kind: 'alert'; message: string; resolve: (v: void) => void }
  | { kind: 'confirm'; message: string; ok?: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; message: string; value: string; password?: boolean; resolve: (v: string | null) => void };

let enqueue: ((r: Req) => void) | null = null;

export const ui = {
  alert(message: string): Promise<void> {
    if (!enqueue) {
      window.alert(message);
      return Promise.resolve();
    }
    return new Promise((resolve) => enqueue!({ kind: 'alert', message, resolve }));
  },
  confirm(message: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
    if (!enqueue) return Promise.resolve(window.confirm(message));
    return new Promise((resolve) => enqueue!({ kind: 'confirm', message, ...opts, resolve }));
  },
  prompt(message: string, value = '', opts: { password?: boolean } = {}): Promise<string | null> {
    if (!enqueue) return Promise.resolve(window.prompt(message, value));
    return new Promise((resolve) => enqueue!({ kind: 'prompt', message, value, ...opts, resolve }));
  },
};

export function DialogHost() {
  const [queue, setQueue] = useState<Req[]>([]);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  const cur = queue[0];

  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    return () => {
      enqueue = null;
    };
  }, []);

  useEffect(() => {
    if (!cur) return;
    if (cur.kind === 'prompt') {
      setValue(cur.value);
      setTimeout(() => input.current?.select(), 30);
    } else setTimeout(() => okBtn.current?.focus(), 30);
  }, [cur]);

  if (!cur) return null;
  const close = (ok: boolean) => {
    if (cur.kind === 'alert') cur.resolve();
    else if (cur.kind === 'confirm') cur.resolve(ok);
    else cur.resolve(ok ? value : null);
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <form
        className="modal dialog"
        role="alertdialog"
        aria-modal
        onSubmit={(e) => {
          e.preventDefault();
          close(true);
        }}
        onKeyDown={(e) => e.key === 'Escape' && close(false)}
      >
        <img className="dialog-ico" src="./icon.svg" alt="" />
        <p className="dialog-msg">{cur.message}</p>
        {cur.kind === 'prompt' && (
          <input ref={input} type={cur.password ? 'password' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        )}
        <div className="dialog-btns">
          {cur.kind !== 'alert' && (
            <button type="button" onClick={() => close(false)}>
              Annuler
            </button>
          )}
          <button ref={okBtn} type="submit" className={cur.kind === 'confirm' && cur.danger ? 'danger-solid' : 'primary'}>
            {cur.kind === 'confirm' ? cur.ok ?? 'OK' : 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}
