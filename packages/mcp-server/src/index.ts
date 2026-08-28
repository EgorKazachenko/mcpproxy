// E4 — MCP-поверхность + stdio-shim + хардненинг IPC. См. docs/02-architecture.md И5, И6.
export { CONFIG_FILE, DEFAULT_CONFIG, configPath, loadConfig, parseConfig } from './config.js';
export type { DaemonConfig, LoadConfigResult, ParseConfigResult } from './config.js';

export { resolveBinary } from './binary.js';
export type { BinaryPolicy, BinaryResolution } from './binary.js';

export { ALL_DENY_CODES, E4_DENY_CODES, denyReason, isExecCode, isTerminal, parseDenyReason, verdictOfExecError } from './deny.js';
export type { DenyCode, E4DenyCode, ParsedDenyReason } from './deny.js';

export { FRAME_MAX_BYTES, createFrameDecoder, encodeFrame } from './ipc/frame.js';
export type { FrameDecoder, FrameOutcome } from './ipc/frame.js';

export { parseClientFrame } from './ipc/wire.js';
export type {
  CallDenied,
  CallFrame,
  CallOk,
  CallReplyFrame,
  ClientFrame,
  ErrorFrame,
  HelloFrame,
  ListFrame,
  ListReplyFrame,
  ParsedClientFrame,
  ServerFrame,
  WelcomeFrame,
} from './ipc/wire.js';

export {
  EndpointError,
  SOCKET_FILE,
  SOCKET_PATH_MAX_BYTES,
  assertSocketPathFits,
  TOKEN_BYTES,
  TOKEN_FILE,
  clearStaleSocket,
  ensureRuntimeDir,
  issueToken,
  readToken,
  runtimeDir,
  socketPath,
  tokenMatches,
  tokenPath,
} from './ipc/endpoint.js';

export { startDaemon } from './daemon/server.js';
export type { Daemon, DaemonOptions, StartDaemonResult } from './daemon/server.js';

export { createPipeline } from './daemon/pipeline.js';
export type { AllowedOutcome, CallInput, CallOutcome, Pipeline, PipelineDeps, RefusedOutcome } from './daemon/pipeline.js';

export { SUPPORTED_PROTOCOL_VERSIONS, negotiate } from './shim/protocol.js';
export type { Negotiation } from './shim/protocol.js';

export { IpcClientError, connectIpc } from './shim/client.js';
export type { IpcClient } from './shim/client.js';

export { wrapUntrusted } from './shim/untrusted.js';
export type { UntrustedWrapping } from './shim/untrusted.js';

export { SERVER_INFO, createShim } from './shim/serve.js';
export type { JsonRpcResponse, Shim, ShimDeps } from './shim/serve.js';
