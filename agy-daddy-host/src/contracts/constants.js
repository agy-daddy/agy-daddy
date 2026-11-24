'use strict';

const HOST_API_VERSION = '1.0.0';

const TRUST_LEVELS = Object.freeze(['T0', 'T1', 'T2']);

const REALMS = Object.freeze(['node', 'page-main', 'page-isolated', 'remote-client']);

const EVENT_KINDS = Object.freeze(['event', 'state', 'service']);

const STATIC_PERMISSIONS = Object.freeze([
  'dom:read',
  'dom:write',
  'page:main-world',
  'rpc:read',
  'rpc:write',
  'bridge:route',
  'fs:plugin-data',
  'fs:brain-read',
  'fs:user-files',
  'net:listen',
  'process:spawn',
  'host:launch-args',
  'host:control',
  'native:install'
]);

const HIGH_RISK_PERMISSIONS = Object.freeze([
  'page:main-world',
  'process:spawn',
  'host:launch-args',
  'host:control',
  'rpc:write',
  'fs:user-files',
  'net:listen',
  'native:install'
]);

// T1 社区已审默认不含以下权限，除非审查单独批准
const T1_RESTRICTED_PERMISSIONS = Object.freeze([
  'page:main-world',
  'process:spawn',
  'host:launch-args',
  'host:control',
  'rpc:write'
]);

const RPC_READ_ALLOWLIST = Object.freeze([
  'GetUserStatus',
  'RetrieveUserQuotaSummary',
  'GetCascadeTrajectoryGeneratorMetadata',
  'GetAllCascadeTrajectories',
  'GetCascadeTrajectory',
  'GetCascadeTrajectorySteps',
  'GetModelResponse',
  'GetAvailableModels',
  'ListAvailableModels',
  'GetCascadeModelConfigData',
  'GetPermissionSettings',
  'GetCapabilities'
]);

const RPC_WRITE_ALLOWLIST = Object.freeze([
  'SendUserCascadeMessage',
  'StartCascade',
  'SetUserModelConfig',
  'UpdateCascadeSettings',
  'CancelCascadeInvocation',
  'AcceptCascadeStep',
  'HandleCascadeUserInteraction',
  'CancelCascadeSteps',
  'DeleteQueuedUserInputStep',
  'SendAllQueuedMessages',
  'RevertToCascadeStep',
  'UpdateConversationAnnotations',
  'UpdatePermissionSettings'
]);

const CONTRIBUTION_POINTS = Object.freeze([
  'topbar.units',
  'topbar.popovers',
  'settings',
  'settings.pages',
  'commands',
  'keybindings',
  'composer.quickActions',
  'chat.navButtons',
  'chat.search',
  'remote.panels',
  'remote.actions',
  'native',
  'locales'
]);

const SETTINGS_FIELD_TYPES = Object.freeze([
  'boolean',
  'enum',
  'string',
  'number',
  'list'
]);

const KNOWN_ANCHORS = Object.freeze([
  'topbar.rightCluster',
  'composer.root',
  'composer.editor',
  'composer.sendButton',
  'chat.scrollViewport',
  'chat.messageList',
  'chat.thinkingTrigger',
  'chat.actionButtons',
  'sidebar.conversationRows',
  'fileViewer.header',
  'settings.dialog',
  'settings.nav',
  'settings.content',
  'settings.openTrigger'
]);

function isValidPermission(perm) {
  if (typeof perm !== 'string' || !perm) return false;
  if (STATIC_PERMISSIONS.includes(perm)) return true;
  if (perm.startsWith('net:outbound:')) {
    const domain = perm.slice('net:outbound:'.length);
    if (!domain) return false;
    return domain === '*' || /^[a-zA-Z0-9*.-]+(?::\d+)?$/.test(domain);
  }
  return false;
}

function isHighRiskPermission(perm) {
  if (HIGH_RISK_PERMISSIONS.includes(perm)) return true;
  if (typeof perm === 'string' && perm.startsWith('net:outbound:')) return true;
  return false;
}

function isValidActivationEvent(ev) {
  if (typeof ev !== 'string' || !ev) return false;
  if (ev === 'onStartup') return true;
  if (/^onSurface:[a-zA-Z0-9._-]+$/.test(ev)) return true;
  if (/^onCommand:[a-zA-Z0-9._-]+$/.test(ev)) return true;
  if (/^onRoute:.+$/.test(ev)) return true;
  return false;
}

module.exports = {
  HOST_API_VERSION,
  TRUST_LEVELS,
  REALMS,
  EVENT_KINDS,
  STATIC_PERMISSIONS,
  HIGH_RISK_PERMISSIONS,
  T1_RESTRICTED_PERMISSIONS,
  RPC_READ_ALLOWLIST,
  RPC_WRITE_ALLOWLIST,
  CONTRIBUTION_POINTS,
  SETTINGS_FIELD_TYPES,
  KNOWN_ANCHORS,
  isValidPermission,
  isHighRiskPermission,
  isValidActivationEvent
};
