import { createContext, useContext, type ReactNode } from 'react';

/** Outil actuellement ouvert dans le panneau Outils (null = grille d'icônes). */
export const ToolNav = createContext<{ active: string | null }>({ active: null });

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const { active } = useContext(ToolNav);
  if (active !== id) return null;
  return (
    <section className="tool-section" aria-label={title}>
      {children}
    </section>
  );
}
