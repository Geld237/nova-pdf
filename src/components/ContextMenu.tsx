import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../icons';

export type MenuItem =
  | { label: string; icon?: IconName; shortcut?: string; danger?: boolean; disabled?: boolean; action: () => void }
  | { header: string }
  | 'sep';

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** Menu contextuel (clic droit / appui long), style macOS. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 6)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 6)),
    });
  }, [menu]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'pointerdown' && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="ctx-sep" />
        ) : 'header' in it ? (
          <div key={i} className="ctx-header">{it.header}</div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.action();
            }}
          >
            <span className="ctx-ico">{it.icon && <Icon name={it.icon} size={15} />}</span>
            <span className="ctx-label">{it.label}</span>
            {it.shortcut && <kbd className="ctx-kbd">{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
