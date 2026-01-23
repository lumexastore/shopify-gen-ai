const ROLES = Object.freeze({
  VISION_PRO: 'VISION_PRO',
  ARCHITECT: 'ARCHITECT',
  BUILDER: 'BUILDER',
  CRITIC: 'CRITIC',
});

// Default model mapping (OpenRouter model IDs).
// Safe, widely available defaults; can be hot-swapped later without code changes.
const DEFAULT_ROLE_MODELS = Object.freeze({
  [ROLES.VISION_PRO]: 'openai/gpt-4o',
  // Needs to be vision-capable because we pass section crops as images.
  [ROLES.ARCHITECT]: 'openai/gpt-4o',
  [ROLES.BUILDER]: 'anthropic/claude-3.5-sonnet',
  [ROLES.CRITIC]: 'openai/gpt-4o',
});

const DEFAULT_ROLE_PARAMS = Object.freeze({
  [ROLES.VISION_PRO]: { temperature: 0.2, max_tokens: 2200 },
  [ROLES.ARCHITECT]: { temperature: 0.1, max_tokens: 2600 },
  [ROLES.BUILDER]: { temperature: 0.1, max_tokens: 2600 },
  [ROLES.CRITIC]: { temperature: 0.2, max_tokens: 1400 },
});

function resolveModelForRole(role, overrides = {}) {
  if (!role) throw new Error('role is required');
  return overrides[role] || DEFAULT_ROLE_MODELS[role];
}

function resolveParamsForRole(role, overrides = {}) {
  if (!role) throw new Error('role is required');
  return { ...(DEFAULT_ROLE_PARAMS[role] || {}), ...(overrides[role] || {}) };
}

module.exports = {
  ROLES,
  DEFAULT_ROLE_MODELS,
  DEFAULT_ROLE_PARAMS,
  resolveModelForRole,
  resolveParamsForRole,
};

