// Pure, filesystem-free config validation. Sibling of load-config.js: this module never
// reads a file itself, only inspects a parsed config object, so it is drivable with plain
// fixtures and never touches the filesystem or a network. Returns every problem it finds as
// a readable string rather than throwing on the first — an operator fixing a config sees all
// of it in one pass. No message produced by this module may ever contain a configured token
// value: a problem is named by its client name and the rule it broke, never by the secret
// that broke it, because this is exactly the surface (a terminal, a screen share, a pasted
// bug report) where a secret leaks.

export const MIN_CLIENT_TOKEN_LENGTH = 16;
export const PLACEHOLDER_TOKEN_PREFIX = 'replace-with-';

const TTS_PROVIDERS = ['macos-say', 'kokoro-onnx'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateConfig(config) {
  // Guard clauses: a config that isn't even a usable object, or that carries no
  // `security` section at all, isn't "a config with a problem" — it's no config, and this
  // function throws rather than trying to produce a useful error list from nothing. Every
  // other check below operates on a config that has at least cleared this bar, and reports
  // its own findings as data (never a throw), per this module's whole purpose.
  if (!isPlainObject(config)) {
    throw new Error('validateConfig: config must be a plain object');
  }
  if (Object.keys(config).length === 0) {
    throw new Error('validateConfig: config is empty — nothing to validate');
  }
  if (!isPlainObject(config.security)) {
    throw new Error('validateConfig: config.security is required and must be a plain object');
  }

  const errors = [];

  // 1. server
  const host = config.server?.host;
  if (typeof host !== 'string' || host.length === 0) {
    errors.push('server.host must be a non-empty string');
  }
  const port = config.server?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('server.port must be an integer between 1 and 65535');
  }

  // 2. security.clients presence and shape — the single most important check here: without
  // it the service boots with zero valid identities and every real request gets a 401 with
  // no startup signal explaining why.
  const clients = config.security.clients;
  const clientsIsPlainObject = isPlainObject(clients);
  if (clients === undefined) {
    errors.push('security.clients is required (a map of client name to token)');
  } else if (!clientsIsPlainObject) {
    errors.push('security.clients must be a plain object mapping client name to token');
  } else if (Object.keys(clients).length === 0) {
    errors.push(
      'security.clients must have at least one entry — a service with zero clients can authenticate nobody',
    );
  }

  // 3/4/5: per-entry name/value shape, token quality (D-08), and duplicate-value detection
  // (revocation independence — AUTH-02) — only meaningful once clients is a usable object.
  if (clientsIsPlainObject) {
    const firstNameForToken = new Map();
    for (const [name, token] of Object.entries(clients)) {
      if (typeof name !== 'string' || name.length === 0) {
        errors.push(`security.clients has an invalid client name: ${JSON.stringify(name)}`);
      }
      if (typeof token !== 'string') {
        errors.push(`security.clients.${name} must be a string token`);
        continue;
      }
      if (token.length < MIN_CLIENT_TOKEN_LENGTH) {
        errors.push(
          `security.clients.${name}'s token must be at least ${MIN_CLIENT_TOKEN_LENGTH} characters`,
        );
      }
      if (token.startsWith(PLACEHOLDER_TOKEN_PREFIX)) {
        errors.push(
          `security.clients.${name} still carries the shipped example placeholder token — set a real secret`,
        );
      }
      const priorName = firstNameForToken.get(token);
      if (priorName !== undefined) {
        errors.push(
          `security.clients.${priorName} and security.clients.${name} share the same token value — each client must have a unique token`,
        );
      } else {
        firstNameForToken.set(token, name);
      }
    }
  }

  // 6. leftover pre-Phase-4 singular shared-secret key. An operator's config.local.json is
  // untracked and this validator cannot edit it — this message is the only place they learn
  // the shape changed.
  if ('token' in config.security) {
    errors.push(
      'security.token is no longer supported — migrate its value into security.clients (a map of client name to token)',
    );
  }

  // 7. allowedOrigins / rate-limit numbers
  if (config.security.allowedOrigins !== undefined) {
    const origins = config.security.allowedOrigins;
    if (!Array.isArray(origins) || origins.some((entry) => typeof entry !== 'string')) {
      errors.push('security.allowedOrigins must be an array of strings');
    }
  }
  if (config.security.rateLimitWindowMs !== undefined) {
    const value = config.security.rateLimitWindowMs;
    if (!Number.isFinite(value) || value <= 0) {
      errors.push('security.rateLimitWindowMs must be a finite number greater than zero');
    }
  }
  if (config.security.rateLimitMaxRequests !== undefined) {
    const value = config.security.rateLimitMaxRequests;
    if (!Number.isFinite(value) || value <= 0) {
      errors.push('security.rateLimitMaxRequests must be a finite number greater than zero');
    }
  }

  // 8. stt / openclaw
  const sttCommand = config.stt?.command;
  if (typeof sttCommand !== 'string' || sttCommand.length === 0) {
    errors.push('stt.command must be a non-empty string');
  }
  const openclawCommand = config.openclaw?.command;
  if (typeof openclawCommand !== 'string' || openclawCommand.length === 0) {
    errors.push('openclaw.command must be a non-empty string');
  }
  const openclawSessionId = config.openclaw?.sessionId;
  if (typeof openclawSessionId !== 'string' || openclawSessionId.length === 0) {
    errors.push('openclaw.sessionId must be a non-empty string');
  }

  // 9. tts — provider must be one of the strings the selector in adapters/tts.js actually
  // branches on; the ONNX provider additionally needs a spawn-fallback command.
  const ttsProvider = config.tts?.provider;
  if (!TTS_PROVIDERS.includes(ttsProvider)) {
    errors.push(`tts.provider must be one of: ${TTS_PROVIDERS.join(', ')}`);
  } else if (ttsProvider === 'kokoro-onnx') {
    const ttsCommand = config.tts?.command;
    if (typeof ttsCommand !== 'string' || ttsCommand.length === 0) {
      errors.push('tts.command must be a non-empty string when tts.provider is kokoro-onnx');
    }
  }

  return errors;
}
