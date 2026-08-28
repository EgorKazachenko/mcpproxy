import type { CallOutcome } from '../shared/callOutcome.js';
import type { StageGroup } from '../shared/stageGroup.js';

/**
 * All UI strings for the application.
 *
 * Single module, not scattered strings: the mockup is frozen and serves as the source of truth
 * for the copy, and without a single home there is no way to verify the implementation against it.
 * Verified structurally — a test walks the AST of the renderer and shared layer and fails on
 * Cyrillic in string literals, JSX text, or template string fragments. Cyrillic is allowed in
 * comments: the entire repository is written that way.
 *
 * Signatures of domain values are not duplicated here — their home is in `@mcpproxy/design`, and
 * a second source of the same value would diverge from the first.
 */
export const STRINGS = {
  app: {
    name: 'mcpproxy',
    sandboxEyebrow: 'sandbox',
    unsandboxedBanner: 'Sandbox is disabled — baseline. Everything this call executes will run with your permissions.',
    faultBanner: (reason: string): string => `Main process rejected the command: ${reason}`,
  },

  nav: {
    timeline: 'Timeline',
    violations: 'Violations',
    policy: 'Policy',
    approvals: 'Approvals',
    audit: 'Audit',
    laterHead: 'Coming in the next run',
    laterBody: 'Screen designed and reviewed. It will appear here with the other surfaces.',
  },

  player: {
    step: 'Step',
    play: 'Play',
    pause: 'Pause',
    reset: 'Reset',
    speed: (multiplier: number): string => `×${multiplier}`,
    speedLabel: 'playback speed',
    position: (position: number, total: number): string => `${position} of ${total}`,
  },

  calls: {
    head: 'Calls',
    perSession: (count: number): string => `${count} per session`,
    loading: 'loading…',
    emptyHead: 'No calls yet',
    emptyBody:
      'Proxy is running and listening on the socket. Each tool call will appear here — allowed or denied.',
    // Rest of the call string. Formulations match the mockup exactly (`callLine` in `mockup.html`).
    verb: (word: string): string => `${word} —`,
    deniedBecause: (reason: string, stage: string): string => `${reason} · stage "${stage}"`,
    awaitingNote: 'high risk — confirmation window outside model context',
    completed: (code: number | null, overheadMs: number): string =>
      `${code === null ? 'terminated by signal' : `exit code ${code}`} · overhead ${overheadMs} ms`,
    sent: (bytes: number): string => ` — ${bytes} bytes`,
    andMore: (count: number): string => ` and ${count} more`,
    pairSeatbelt: 'same call, repeated with sandbox',
    pairNone: 'same call, four seconds earlier — without sandbox',
  },

  outcome: {
    blocked: 'Blocked',
    passed: 'Passed',
    denied: 'Denied',
    awaiting: 'Awaiting Confirmation',
    clean: 'Completed',
    running: 'Running',
    failed: 'Error',
  } satisfies Record<CallOutcome, string>,

  group: {
    checks: 'checks',
    setup: 'setup',
    execution: 'execution',
  } satisfies Record<StageGroup, string>,

  detail: {
    head: 'Call Details',
    callSection: 'Call',
    commandSection: 'Command',
    stagesSection: 'Stages',
    redactSection: 'Redaction',
    tool: 'tool',
    verdict: 'verdict',
    risk: 'risk',
    cwd: 'working directory',
    env: 'allowed environment variables',
    profile: 'sandbox profile',
    sandbox: 'sandbox',
    notSelectedHead: 'No call selected',
    notSelectedBody: 'Select a row on the left to see stages, command, and sandbox profile.',
    deniedAt: (stage: string): string => `Denied at stage "${stage}"`,
    deniedNote: 'Call did not reach "spawn" stage: process was not created.',
    notBuilt: (stage: string): string =>
      `Command was not built: call stopped at stage "${stage}", argv assembly was not reached.`,
    fromParams: 'Highlighted — substituted from call parameters; rest is defined by the manifest and unavailable to the model.',
    absent: (stages: string): string => `Were not executed and are absent from the log: ${stages}.`,
    overhead: 'proxy overhead — sum of stages outside execution, violations, confirmation, and completion',
    noDuration: '—',
    seconds: 's',
    milliseconds: 'ms',
  },

  stage: {
    bytes: 'bytes',
    received: (session: string): string => `call from session ${session}`,
    lockMatch: 'recipe matches lock',
    lockDrift: 'recipe definition diverged from lock',
    validateOk: 'parameters match the schema',
    validateFail: 'parameter failed validation',
    pathOk: (cwd: string): string => `working directory ${cwd}`,
    pathFail: 'path outside allowed root',
    buildArgv: (total: number, fromParams: number): string =>
      `${total} elements, ${fromParams} substituted from parameters`,
    riskUnknown: 'tier not determined',
    approvalPending: 'awaiting confirmation outside model context',
    approvalDone: 'approval decision received',
    envEmpty: 'no environment variables allowed',
    profileApplied: 'sandbox profile applied',
    profileSkipped: 'profile not applied — process runs with your permissions',
    violation: (kind: string, target: string, volume: string): string => `${kind}: ${target}, ${volume}`,
    spawned: 'process spawned',
    violationUnknown: 'violation without description',
    redactNone: 'no redaction rules matched',
    redaction: (rule: string, count: number, stream: string): string => `${rule} — ${count} in ${stream}`,
    complete: (code: number | null): string =>
      code === null ? 'process terminated by signal' : `exit code ${code}`,
    unknown: 'stage unknown to this build',
  },
} as const;
