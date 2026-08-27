import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { normalizeRecipe } from '@mcpproxy/contracts';
import type { Defaults, NormalizedSandbox, Recipe } from '@mcpproxy/contracts';
import { buildProfile, mandatoryDenyGlobs, policyHash, resolveProfilePath, toSandboxProfile } from './profile.js';

/**
 * Дефолты — форма из канонического примера `docs/07-contracts.md`: `read.deny` закрывает
 * учётные каталоги (атака A10), запись разрешена точечно, сети нет.
 */
const DEFAULTS: Defaults = {
  timeout: '120s',
  output: { maxBytes: 65_536, redact: true },
  env: { allow: ['PATH', 'HOME'] },
  sandbox: {
    read: { deny: ['~/.ssh', '~/.aws', '~/.config/gh'] },
    write: { allow: [] },
    network: { allow: [] },
  },
};

const sandboxOf = (recipe: Recipe): NormalizedSandbox => normalizeRecipe(recipe, DEFAULTS).effective.sandbox;

const RECIPE_BASE: Recipe = { description: 'x', exec: ['/bin/true'] };

describe('resolveProfilePath (R8)', () => {
  it('разворачивает тильду', () => {
    expect(resolveProfilePath('~/.ssh', '/recipe')).toBe(`${homedir()}/.ssh`);
    expect(resolveProfilePath('~', '/recipe')).toBe(homedir());
  });

  it('резолвит относительные от каталога РЕЦЕПТА, а не демона', () => {
    expect(resolveProfilePath('./logs', '/recipe/dir')).toBe('/recipe/dir/logs');
    // Ловушка, ради которой параметр вообще есть: с cwd демона получилось бы совсем другое.
    expect(resolveProfilePath('./logs', '/recipe/dir')).not.toBe(`${process.cwd()}/logs`);
  });

  it('абсолютные оставляет как есть', () => {
    expect(resolveProfilePath('/private/tmp/x', '/recipe')).toBe('/private/tmp/x');
  });
});

describe('buildProfile — mandatory deny (R9)', () => {
  const sandbox = sandboxOf({ ...RECIPE_BASE, sandbox: { write: { allow: ['/tmp/x'] } } });

  it('якорится на каждом корне write.allow, а не на cwd рецепта', () => {
    // Каталоги РАЗВЕДЕНЫ намеренно: при совпадении дефект маскируется — это ровно то, что
    // проба П3b показала для вендорской реализации, якорящей на cwd демона.
    const policy = buildProfile(sandbox, ['/tmp/x'], '/completely/other');

    expect(policy.write.deny).toContain('/tmp/x/**/.git/hooks');
    expect(policy.write.deny).toContain('/tmp/x/**/.git/config');
    expect(policy.write.deny).toContain('/tmp/x/**/.zshrc');
  });

  it('даёт глоб на поддерево, а не литерал в корне', () => {
    // Литерал `<корень>/.git/hooks` оставил бы `<корень>/sub/.git/hooks/pre-commit`
    // записываемым — это S6 ровно на уровень глубже.
    const policy = buildProfile(sandbox, ['/tmp/x'], '/completely/other');
    expect(policy.write.deny).not.toContain('/tmp/x/.git/hooks');
    expect(policy.write.deny.filter((one) => one.includes('.git/hooks'))).toEqual(['/tmp/x/**/.git/hooks']);
  });

  it('якорит на КАЖДОМ корне, а не только на первом', () => {
    const two = buildProfile(sandbox, ['/tmp/x', '/tmp/y'], '/other');
    expect(two.write.deny).toContain('/tmp/x/**/.git/hooks');
    expect(two.write.deny).toContain('/tmp/y/**/.git/hooks');
  });

  it('резолвит сами корни — иначе `~/work/**/.git/hooks` выглядит защитой и ею не является', () => {
    const policy = buildProfile(sandbox, ['~/work'], '/other');
    expect(policy.write.deny).toContain(`${homedir()}/work/**/.git/hooks`);
    expect(policy.write.deny.some((one) => one.startsWith('~'))).toBe(false);
  });

  it('сохраняет собственный `write.deny` рецепта рядом с обязательными', () => {
    const withDeny = sandboxOf({ ...RECIPE_BASE, sandbox: { write: { allow: ['/tmp/x'], deny: ['/tmp/x/secret'] } } });
    const policy = buildProfile(withDeny, ['/tmp/x'], '/other');
    expect(policy.write.deny).toContain('/tmp/x/secret');
    expect(policy.write.deny).toContain('/tmp/x/**/.git/hooks');
  });

  it('без корней записи обязательных запретов не порождает — запрещать не в чем', () => {
    expect(mandatoryDenyGlobs([])).toEqual([]);
  });
});

describe('buildProfile — чтение (R7, R8)', () => {
  it('разворачивает тильду в read.deny — иначе `~/.ssh` уезжает в srt дословно', () => {
    const policy = buildProfile(sandboxOf(RECIPE_BASE), [], '/recipe');
    expect(policy.read.deny).toContain(`${homedir()}/.ssh`);
    expect(policy.read.deny).toContain(`${homedir()}/.aws`);
  });

  /**
   * R7 закрепляет **фактическое** поведение против того, как манифест читается: чтение
   * разрешено по умолчанию, `read.deny` закрывает, `read.allow` лишь прорезает островки
   * внутри закрытого. Значит `analyze_logs` с `read.allow: ["./logs"]` чтение НЕ ограничивает,
   * а `~/.ssh` остаётся закрытым дефолтами — и строка merge-таблицы `07-contracts.md:154`
   * («рецепт осознанно сужает или расширяет свой blast radius») для узла `read` вводит в
   * заблуждение.
   */
  it('read.allow рецепта чтение не сужает, а A10 закрывают только дефолты', () => {
    const analyzeLogs = sandboxOf({ ...RECIPE_BASE, sandbox: { read: { allow: ['./logs'] } } });
    const policy = buildProfile(analyzeLogs, [], '/recipe/dir');

    expect(policy.read.allow).toEqual(['/recipe/dir/logs']);
    expect(policy.read.deny).toContain(`${homedir()}/.ssh`);
    expect(policy.read.deny).toContain(`${homedir()}/.config/gh`);
  });
});

describe('buildProfile — бейдж ослабленности (R14)', () => {
  const withNetwork = (allow: string[]): NormalizedSandbox =>
    sandboxOf({ ...RECIPE_BASE, sandbox: { network: { allow } } });

  it('голая звёздочка помечает, рабочие правила — нет', () => {
    expect(buildProfile(withNetwork(['*']), [], '/r').weakened).toBe(true);
    expect(buildProfile(withNetwork(['*.github.com', '*.npmjs.org']), [], '/r').weakened).toBe(false);
    expect(buildProfile(withNetwork([]), [], '/r').weakened).toBe(false);
  });
});

describe('toSandboxProfile (R36)', () => {
  it('отдаёт изменяемые массивы сырого SandboxProfile, а не readonly нормализованного', () => {
    const sandbox = sandboxOf({ ...RECIPE_BASE, sandbox: { write: { allow: ['/tmp/x'] } } });
    const profile = toSandboxProfile(sandbox);

    expect(profile.write?.allow).toEqual(['/tmp/x']);
    expect(profile.read?.deny).toEqual(['~/.ssh', '~/.aws', '~/.config/gh']);
    // Копия, а не та же ссылка: событие уезжает в JCS и в хэш цепочки, и общая ссылка
    // означала бы, что мутация профиля задним числом меняет уже посчитанный дайджест.
    expect(profile.write?.allow).not.toBe(sandbox.write.allow);
  });

  it('несёт СЫРЫЕ пути манифеста, а не резолвнутые — их резолвит buildProfile', () => {
    const profile = toSandboxProfile(sandboxOf(RECIPE_BASE));
    expect(profile.read?.deny).toContain('~/.ssh');
    expect(profile.read?.deny).not.toContain(`${homedir()}/.ssh`);
  });
});

describe('policyHash (R47)', () => {
  const policy = buildProfile(sandboxOf(RECIPE_BASE), ['/tmp/x'], '/r');

  it('различает вызовы, отличающиеся ТОЛЬКО сетью', () => {
    const closed = policyHash(policy, { allowedDomains: [], deniedDomains: [] });
    const open = policyHash(policy, { allowedDomains: ['*'], deniedDomains: [] });
    expect(closed).not.toBe(open);
  });

  it('различает вызовы, отличающиеся только deniedDomains (R53)', () => {
    const a = policyHash(policy, { allowedDomains: ['*.github.com'], deniedDomains: [] });
    const b = policyHash(policy, { allowedDomains: ['*.github.com'], deniedDomains: ['api.github.com'] });
    expect(a).not.toBe(b);
  });

  it('различает вызовы, отличающиеся файловой частью', () => {
    const other = buildProfile(sandboxOf(RECIPE_BASE), ['/tmp/y'], '/r');
    const net = { allowedDomains: [], deniedDomains: [] };
    expect(policyHash(policy, net)).not.toBe(policyHash(other, net));
  });

  it('стабилен: тот же вход — тот же хэш, и это шестьдесят четыре hex-символа', () => {
    const net = { allowedDomains: ['*.github.com'], deniedDomains: [] };
    expect(policyHash(policy, net)).toBe(policyHash(policy, net));
    expect(policyHash(policy, net)).toMatch(/^[0-9a-f]{64}$/);
  });
});
