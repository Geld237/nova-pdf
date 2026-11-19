import { useMemo, useRef } from 'react';
import { download } from '../pdf/tools';

export interface MapNode {
  text: string;
  page?: number;
  children: MapNode[];
}

/** Lit un plan Markdown (# titre, puis listes indentées « - ») et en fait un arbre. */
export function parseOutline(md: string, fallbackTitle = 'Document'): MapNode {
  const root: MapNode = { text: fallbackTitle, children: [] };
  const stack: { node: MapNode; level: number }[] = [{ node: root, level: -1 }];
  let sawTitle = false;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\t/g, '  ').replace(/\*\*/g, '');
    if (!line.trim() || /^```/.test(line.trim())) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    let level: number;
    let text: string;
    if (h) {
      if (h[1].length === 1 && !sawTitle) {
        root.text = h[2].trim();
        sawTitle = true;
        continue;
      }
      level = (h[1].length - 2) * 10; // ## = branche principale
      text = h[2];
    } else {
      const b = line.match(/^(\s*)(?:[-*+•]|\d+[.)])\s+(.*)$/);
      if (!b) continue;
      level = 100 + b[1].length; // les puces sont sous les titres
      text = b[2];
    }
    text = text.trim();
    if (!text) continue;
    const pm = text.match(/\[p\.?\s*(\d+)[^\]]*\]/i);
    const node: MapNode = { text: text.replace(/\s*\[p\.?[^\]]*\]/gi, '').trim(), page: pm ? +pm[1] - 1 : undefined, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, level });
  }
  // un seul enfant au premier niveau qui contient tout : on remonte d'un cran
  if (root.children.length === 1 && root.children[0].children.length > 1 && !sawTitle) return root.children[0];
  return root;
}

const COLORS = ['#3d52d5', '#ff9500', '#34c759', '#af52de', '#ff2d55', '#30b0c7', '#a2845e', '#5856d6'];

interface Laid {
  n: MapNode;
  x: number;
  y: number;
  w: number;
  depth: number;
  color: string;
  lines: string[];
  parent?: Laid;
}

const wrap = (s: string, max: number) => {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) {
      out.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, 3);
};

/** Carte mentale en arbre horizontal (racine à gauche), exportable en SVG / PNG. */
export function MindMap({ tree, goTo, name = 'carte-mentale' }: { tree: MapNode; goTo?: (p: number) => void; name?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { nodes, width, height } = useMemo(() => {
    const out: Laid[] = [];
    const LINE = 15;
    const GAP = 10;
    const COLW = [190, 200, 190, 180, 170];
    const maxChars = [22, 26, 28, 28, 28];
    let y = 20;
    const place = (n: MapNode, depth: number, color: string, parent?: Laid): Laid => {
      const lines = wrap(n.text, maxChars[Math.min(depth, 4)]);
      const h = lines.length * LINE + 10;
      const x = 20 + COLW.slice(0, depth).reduce((a, b) => a + b, 0);
      const me: Laid = { n, x, y: 0, w: COLW[Math.min(depth, 4)] - 30, depth, color, lines, parent };
      out.push(me);
      if (!n.children.length) {
        me.y = y + h / 2;
        y += h + GAP;
      } else {
        const kids = n.children.map((c, i) => place(c, depth + 1, depth === 0 ? COLORS[i % COLORS.length] : color, me));
        me.y = (kids[0].y + kids[kids.length - 1].y) / 2;
      }
      return me;
    };
    place(tree, 0, '#1c1e26');
    const width = Math.max(...out.map((o) => o.x + o.w)) + 20;
    return { nodes: out, width, height: y + 10 };
  }, [tree]);

  const exportSvg = () => {
    const s = svgRef.current;
    if (!s) return;
    const xml = new XMLSerializer().serializeToString(s);
    download(new Blob([xml], { type: 'image/svg+xml' }), `${name}.svg`, 'image/svg+xml');
  };
  const exportPng = async () => {
    const s = svgRef.current;
    if (!s) return;
    const xml = new XMLSerializer().serializeToString(s);
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = width * 2;
    c.height = height * 2;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.scale(2, 2);
    g.drawImage(img, 0, 0);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    download(blob, `${name}.png`, 'image/png');
  };
  const toMarkdown = () => {
    const lines: string[] = [`# ${tree.text}`];
    const walk = (n: MapNode, d: number) => n.children.forEach((c) => {
      lines.push(`${'  '.repeat(d)}- ${c.text}${c.page != null ? ` [p. ${c.page + 1}]` : ''}`);
      walk(c, d + 1);
    });
    walk(tree, 0);
    return lines.join('\n');
  };

  return (
    <div className="mindmap">
      <div className="mindmap-scroll">
        <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} fontFamily="Inter, -apple-system, Segoe UI, sans-serif">
          <rect width={width} height={height} fill="#ffffff" />
          {nodes.filter((n) => n.parent).map((n, i) => {
            const p = n.parent!;
            const x1 = p.x + p.w;
            const x2 = n.x;
            const mx = (x1 + x2) / 2;
            return <path key={`l${i}`} d={`M${x1},${p.y} C${mx},${p.y} ${mx},${n.y} ${x2},${n.y}`} fill="none" stroke={n.color} strokeOpacity={0.55} strokeWidth={n.depth === 1 ? 2.4 : 1.5} />;
          })}
          {nodes.map((n, i) => {
            const h = n.lines.length * 15 + 10;
            const root = n.depth === 0;
            const branch = n.depth === 1;
            return (
              <g key={i} transform={`translate(${n.x},${n.y - h / 2})`} style={{ cursor: n.n.page != null && goTo ? 'pointer' : undefined }} onClick={() => n.n.page != null && goTo?.(n.n.page)}>
                <rect width={n.w} height={h} rx={root ? 12 : 8} fill={root ? n.color : branch ? n.color : '#ffffff'} fillOpacity={root ? 1 : branch ? 0.12 : 1} stroke={n.color} strokeOpacity={root ? 0 : 0.5} />
                {n.lines.map((l, k) => (
                  <text key={k} x={8} y={17 + k * 15} fontSize={root ? 13 : 12} fontWeight={root || branch ? 600 : 400} fill={root ? '#ffffff' : '#1c1e26'}>{l}</text>
                ))}
                {n.n.page != null && <text x={n.w - 6} y={h - 4} fontSize={9} textAnchor="end" fill={n.color}>p. {n.n.page + 1}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="msg-actions">
        <button className="link" onClick={exportPng}>Exporter en PNG</button>
        <button className="link" onClick={exportSvg}>SVG</button>
        <button className="link" onClick={() => navigator.clipboard?.writeText(toMarkdown())}>Copier le plan</button>
      </div>
    </div>
  );
}
