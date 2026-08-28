import type { CallOutcome } from '../shared/callOutcome.js';
import type { StageGroup } from '../shared/stageGroup.js';

/**
 * Вся экранная проза приложения.
 *
 * Один модуль, а не строки по месту: макет заморожен и служит источником истины для копии, и
 * без единственного дома сверить реализацию с ним нечем. Проверяется структурно — тест
 * обходит AST рендерера и общего слоя и падает на кириллице в строковом литерале, в тексте
 * JSX или в куске шаблонной строки. В комментариях кириллица разрешена: ими написан весь
 * репозиторий.
 *
 * Подписи ДОМЕННЫХ значений сюда не дублируются — их дом в `@mcpproxy/design`, и второй
 * источник одного значения разошёлся бы с первым.
 */
export const STRINGS = {
  app: {
    name: 'mcpproxy',
    sandboxEyebrow: 'песочница',
    unsandboxedBanner: 'Песочница выключена — baseline. Всё, что запустит вызов, выполняется с вашими правами.',
  },

  nav: {
    timeline: 'Таймлайн',
    violations: 'Нарушения',
    policy: 'Политика',
    approvals: 'Апрувы',
    audit: 'Аудит',
    laterHead: 'Появится в следующем ране',
    laterBody: 'Экран спроектирован и прошёл дизайн-ревью. Здесь он появится вместе с остальными поверхностями.',
  },

  player: {
    step: 'Шаг',
    play: 'Играть',
    pause: 'Пауза',
    reset: 'Сброс',
    position: (position: number, total: number): string => `${position} из ${total}`,
  },

  calls: {
    head: 'Вызовы',
    perSession: (count: number): string => `${count} за сессию`,
    loading: 'загружаем…',
    emptyHead: 'Вызовов пока не было',
    emptyBody:
      'Прокси запущен и слушает сокет. Здесь появится каждый вызов инструмента — и разрешённый, и отклонённый.',
    pairSeatbelt: 'тот же вызов, повторён с песочницей',
    pairNone: 'тот же вызов, четырьмя секундами раньше — без песочницы',
  },

  outcome: {
    blocked: 'Отбито',
    passed: 'Прошло',
    denied: 'Отказано',
    awaiting: 'Ждёт подтверждения',
    clean: 'Выполнено',
    running: 'Выполняется',
  } satisfies Record<CallOutcome, string>,

  group: {
    checks: 'проверки',
    setup: 'подготовка',
    execution: 'исполнение',
  } satisfies Record<StageGroup, string>,

  detail: {
    head: 'Детали вызова',
    callSection: 'Вызов',
    commandSection: 'Команда',
    stagesSection: 'Стадии',
    redactSection: 'Редакция',
    tool: 'инструмент',
    verdict: 'вердикт',
    risk: 'риск',
    cwd: 'рабочий каталог',
    env: 'разрешённые переменные',
    profile: 'профиль песочницы',
    sandbox: 'песочница',
    notSelectedHead: 'Вызов не выбран',
    notSelectedBody: 'Выберите строку слева, чтобы увидеть стадии, команду и профиль песочницы.',
    deniedAt: (stage: string): string => `Отказано на стадии «${stage}»`,
    deniedNote: 'Вызов до стадии «запуск» не дошёл: процесс не создавался.',
    notBuilt: (stage: string): string =>
      `Команда не собиралась: вызов остановлен на стадии «${stage}», до сборки argv он не дошёл.`,
    fromParams: 'Подсвечено — подставлено из параметров вызова; остальное задано манифестом и модели недоступно.',
    absent: (stages: string): string => `Не выполнялись и в записи отсутствуют: ${stages}.`,
    overhead: 'оверхед прокси — сумма стадий вне запуска, нарушений, подтверждения и завершения',
    noDuration: '—',
    seconds: 'с',
    milliseconds: 'мс',
  },

  stage: {
    bytes: 'байт',
    received: (session: string): string => `вызов от сессии ${session}`,
    lockMatch: 'рецепт совпадает с lock',
    lockDrift: 'определение рецепта разошлось с lock',
    validateOk: 'параметры соответствуют схеме',
    validateFail: 'параметр не прошёл проверку',
    pathOk: (cwd: string): string => `рабочий каталог ${cwd}`,
    pathFail: 'путь вне разрешённого корня',
    buildArgv: (total: number, fromParams: number): string =>
      `${total} элемента, из параметров подставлено ${fromParams}`,
    riskUnknown: 'тир не определён',
    approvalPending: 'ожидает подтверждения вне контекста модели',
    approvalDone: 'решение человека получено',
    envEmpty: 'ни одной переменной не разрешено',
    profileApplied: 'профиль песочницы применён',
    profileSkipped: 'профиль не применяется — процесс запущен с вашими правами',
    violation: (kind: string, target: string, volume: string): string => `${kind}: ${target}, ${volume}`,
    spawned: 'процесс запущен',
    violationUnknown: 'нарушение без описания',
    redactNone: 'совпадений правил редакции нет',
    redaction: (rule: string, count: number, stream: string): string => `${rule} — ${count} в ${stream}`,
    complete: (code: number | null): string =>
      code === null ? 'процесс завершён сигналом' : `код выхода ${code}`,
    unknown: 'стадия неизвестна этой сборке',
  },
} as const;
