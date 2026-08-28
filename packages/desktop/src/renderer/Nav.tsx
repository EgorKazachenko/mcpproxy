import { STRINGS } from './strings.js';

export type Screen = 'timeline' | 'violations' | 'policy' | 'approvals' | 'audit';

export const SCREENS: readonly Screen[] = ['timeline', 'violations', 'policy', 'approvals', 'audit'];

const LABEL: Readonly<Record<Screen, string>> = {
  timeline: STRINGS.nav.timeline,
  violations: STRINGS.nav.violations,
  policy: STRINGS.nav.policy,
  approvals: STRINGS.nav.approvals,
  audit: STRINGS.nav.audit,
};

/**
 * Пять разделов сразу, а не один.
 *
 * Четыре из них в этом ране ведут на видимую заглушку: рисовать мёртвые пункты нельзя, но и
 * прятать их значит переделывать навигацию дважды и потерять форму, которую уже проверило
 * дизайн-ревью.
 */
export function Nav({ active, onSelect }: { active: Screen; onSelect: (screen: Screen) => void }) {
  return (
    <nav className="nav" aria-label={STRINGS.nav.timeline}>
      {SCREENS.map((screen) => (
        <button
          key={screen}
          type="button"
          aria-current={screen === active ? 'page' : undefined}
          onClick={() => onSelect(screen)}
        >
          {LABEL[screen]}
        </button>
      ))}
    </nav>
  );
}
