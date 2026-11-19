import { useEffect, useRef, useState } from 'react';

/* Glisser-déposer pour classer des pages, au pointeur (souris, doigt, stylet) — plus fiable que le glisser-déposer HTML :
   - souris : on attrape et on glisse ; doigt : appui long puis glisser ;
   - une ligne d'insertion montre où les pages iront ; la liste défile toute seule près des bords ;
   - plusieurs pages sélectionnées se déplacent ensemble. */

export interface SortState {
  dragging: number[] | null; // indices déplacés
  insertAt: number | null; // position d'insertion (0…n)
  pos: { x: number; y: number } | null; // pointeur (pour l'étiquette qui suit)
}

interface Opts {
  axis: 'x' | 'y' | 'grid'; // liste horizontale, verticale ou grille
  /** indices à déplacer quand on attrape l'élément i (la sélection s'il en fait partie) */
  pick: (i: number) => number[];
  onDrop: (from: number[], to: number) => void;
  container: React.RefObject<HTMLElement | null>;
}

export function useSortable({ axis, pick, onDrop, container }: Opts) {
  const [st, setSt] = useState<SortState>({ dragging: null, insertAt: null, pos: null });
  const start = useRef<{ i: number; x: number; y: number; id: number; touch: boolean; timer: number | null; active: boolean } | null>(null);
  const justDragged = useRef(false);
  const live = useRef(st);
  live.current = st;
  const opts = useRef({ pick, onDrop, axis });
  opts.current = { pick, onDrop, axis };

  const insertionFor = (x: number, y: number): number | null => {
    const root = container.current;
    if (!root) return null;
    const els = [...root.querySelectorAll<HTMLElement>('[data-sort-index]')];
    if (!els.length) return null;
    let best = { d: Infinity, at: 0 };
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const i = Number(el.dataset.sortIndex);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = opts.current.axis === 'y' ? Math.abs(y - cy) : opts.current.axis === 'x' ? Math.abs(x - cx) : Math.hypot((x - cx) / Math.max(1, r.width), (y - cy) / Math.max(1, r.height));
      if (d < best.d) {
        const after = opts.current.axis === 'y' ? y > cy : x > cx;
        best = { d, at: after ? i + 1 : i };
      }
    }
    return best.at;
  };

  useEffect(() => {
    let raf = 0;
    const autoScroll = (y: number, x: number) => {
      const root = container.current;
      if (!root) return;
      const r = root.getBoundingClientRect();
      const edge = 48;
      const dy = y < r.top + edge ? -12 : y > r.bottom - edge ? 12 : 0;
      const dx = x < r.left + edge ? -12 : x > r.right - edge ? 12 : 0;
      if (dy) root.scrollTop += dy;
      if (dx && opts.current.axis === 'x') root.scrollLeft += dx;
    };
    const move = (e: PointerEvent) => {
      const s = start.current;
      if (!s || e.pointerId !== s.id) return;
      if (!s.active) {
        const far = Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6;
        if (!far) return;
        if (s.touch) {
          // au doigt, bouger avant l'appui long = faire défiler la liste
          if (s.timer) clearTimeout(s.timer);
          start.current = null;
          return;
        }
        s.active = true;
        setSt({ dragging: opts.current.pick(s.i), insertAt: insertionFor(e.clientX, e.clientY), pos: { x: e.clientX, y: e.clientY } });
        return;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        autoScroll(e.clientY, e.clientX);
        setSt((p) => ({ ...p, insertAt: insertionFor(e.clientX, e.clientY), pos: { x: e.clientX, y: e.clientY } }));
      });
    };
    const up = (e: PointerEvent) => {
      const s = start.current;
      if (!s || e.pointerId !== s.id) return;
      if (s.timer) clearTimeout(s.timer);
      start.current = null;
      const cur = live.current;
      if (s.active && cur.dragging && cur.insertAt != null) {
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 50);
        const from = cur.dragging;
        const to = cur.insertAt;
        // lâché au même endroit : rien à faire
        const same = from.length === 1 && (to === from[0] || to === from[0] + 1);
        if (!same) opts.current.onDrop(from, to);
      }
      setSt({ dragging: null, insertAt: null, pos: null });
    };
    const blockScroll = (e: TouchEvent) => {
      if (start.current?.active && e.cancelable) e.preventDefault();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('touchmove', blockScroll, { passive: false });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('touchmove', blockScroll);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** à placer sur chaque élément (avec data-sort-index) */
  const handle = (i: number) => ({
    'data-sort-index': i,
    draggable: false,
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const touch = e.pointerType !== 'mouse';
      const s = { i, x: e.clientX, y: e.clientY, id: e.pointerId, touch, timer: null as number | null, active: false };
      if (touch) {
        // appui long : la page « se soulève » et suit le doigt
        s.timer = window.setTimeout(() => {
          if (start.current !== s) return;
          s.active = true;
          navigator.vibrate?.(15);
          setSt({ dragging: opts.current.pick(i), insertAt: i, pos: { x: s.x, y: s.y } });
        }, 380);
      }
      start.current = s;
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (justDragged.current) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    onContextMenuCapture: (e: React.MouseEvent) => {
      // l'appui long tactile ouvre aussi le menu contextuel : pas pendant un glisser
      if (start.current?.active || live.current.dragging) e.preventDefault();
    },
  });

  return { st, handle };
}
