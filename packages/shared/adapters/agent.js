// Agent provider selector, the counterpart of tts.js for the conversation stage. Every
// provider exposes the same shape — (text, agentConfig, { signal }) → { text, rawText, meta }
// — so the pipeline never learns which agent is on the other end.

import { sendTurnToOpenClaw, getOpenClawCommand } from './agent-openclaw-cli.js';
import { sendTurnToHermes, getHermesCommand } from './agent-hermes-cli.js';
import { sendTurnToCommand } from './agent-command.js';

export const AGENT_PROVIDERS = ['openclaw', 'hermes', 'command'];
export const DEFAULT_AGENT_PROVIDER = 'openclaw';

export function getAgentProvider(agentConfig = {}) {
  return agentConfig.provider || DEFAULT_AGENT_PROVIDER;
}

// The executable a startup preflight or health probe should resolve for this provider —
// the configured command, or the provider's own default when none is set.
export function getAgentCommand(agentConfig = {}) {
  switch (getAgentProvider(agentConfig)) {
    case 'openclaw':
      return getOpenClawCommand(agentConfig);
    case 'hermes':
      return getHermesCommand(agentConfig);
    default:
      return agentConfig.command ?? '';
  }
}

export async function sendTurnToAgent(text, agentConfig = {}, { signal } = {}) {
  const provider = getAgentProvider(agentConfig);
  if (provider === 'openclaw') {
    return sendTurnToOpenClaw(text, agentConfig, { signal });
  }
  if (provider === 'hermes') {
    return sendTurnToHermes(text, agentConfig, { signal });
  }
  if (provider === 'command') {
    return sendTurnToCommand(text, agentConfig, { signal });
  }
  throw new Error(`Unsupported agent provider: ${provider}`);
}
