'use strict';

const {
  HOST_API_VERSION,
  TRUST_LEVELS,
  REALMS,
  T1_RESTRICTED_PERMISSIONS,
  CONTRIBUTION_POINTS,
  SETTINGS_FIELD_TYPES,
  isValidPermission,
  isHighRiskPermission,
  isValidActivationEvent
} = require('./constants');
const { parseSemver, isValidRange, satisfies } = require('./semver');

const ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const PUBLISHER_RE = /^[a-z0-9][a-z0-9-]*$/;
const TOPIC_RE = /^[a-z0-9-]+:[a-z0-9.-]+@\d+$/;

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function validateDisplayName(val, errors) {
  if (typeof val === 'string') {
    if (!val.trim()) errors.push('displayName must be a non-empty string or locale map');
    return;
  }
  if (isPlainObject(val)) {
    const keys = Object.keys(val).filter((k) => typeof val[k] === 'string' && val[k].trim());
    if (!keys.length) {
      errors.push('displayName locale map must contain at least one non-empty string');
    }
    return;
  }
  errors.push('displayName is required');
}

function validateRelativeEntry(val, field, errors) {
  if (val === undefined) return;
  if (typeof val !== 'string' || !val.trim() || val.startsWith('/') || val.includes('..')) {
    errors.push(`${field} must be a safe relative path without ".."`);
  }
}

function validateManifest(manifest, options = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(manifest)) {
    return { ok: false, errors: ['manifest must be a JSON object'], warnings };
  }

  if (manifest.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1');
  }
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) {
    errors.push('id must match "<publisher>.<name>" lowercase slug format');
  }
  if (typeof manifest.publisher !== 'string' || !PUBLISHER_RE.test(manifest.publisher)) {
    errors.push('publisher must match lowercase slug format');
  } else if (typeof manifest.id === 'string' && !manifest.id.startsWith(`${manifest.publisher}.`)) {
    errors.push('id must start with "<publisher>."');
  }
  if (!parseSemver(manifest.version)) {
    errors.push('version must be a valid SemVer string');
  }
  validateDisplayName(manifest.displayName, errors);

  if (!isPlainObject(manifest.engines) || !isValidRange(manifest.engines.agyDaddy)) {
    errors.push('engines.agyDaddy must be a valid SemVer range');
  } else if (options.checkHostCompatibility !== false) {
    const hostVer = options.hostApiVersion || HOST_API_VERSION;
    if (!satisfies(hostVer, manifest.engines.agyDaddy)) {
      errors.push(`engines.agyDaddy (${manifest.engines.agyDaddy}) is incompatible with host API v${hostVer}`);
    }
  }
  if (manifest.engines?.antigravity !== undefined && !isValidRange(manifest.engines.antigravity)) {
    errors.push('engines.antigravity must be a valid SemVer range');
  }

  validateRelativeEntry(manifest.main, 'main', errors);
  validateRelativeEntry(manifest.renderer, 'renderer', errors);
  validateRelativeEntry(manifest.remote, 'remote', errors);

  if (manifest.world !== undefined && manifest.world !== 'main' && manifest.world !== 'isolated') {
    errors.push('world must be "main" or "isolated"');
  }

  if (manifest.dataVersion !== undefined) {
    if (!Number.isInteger(manifest.dataVersion) || manifest.dataVersion < 1) {
      errors.push('dataVersion must be a positive integer');
    }
  }

  if (manifest.activationEvents !== undefined) {
    if (!Array.isArray(manifest.activationEvents) || !manifest.activationEvents.every(isValidActivationEvent)) {
      errors.push('activationEvents must be an array of valid activation events');
    }
  }

  if (manifest.requires !== undefined) {
    if (!isPlainObject(manifest.requires)) {
      errors.push('requires must be an object');
    } else if (manifest.requires.anchors !== undefined) {
      if (!Array.isArray(manifest.requires.anchors) || !manifest.requires.anchors.every((a) => typeof a === 'string' && a.trim())) {
        errors.push('requires.anchors must be an array of non-empty strings');
      }
    }
  }

  if (manifest.provides !== undefined) {
    if (!isPlainObject(manifest.provides)) {
      errors.push('provides must be an object');
    } else {
      if (manifest.provides.services !== undefined) {
        if (!isPlainObject(manifest.provides.services)) {
          errors.push('provides.services must be an object');
        } else {
          for (const [svcName, spec] of Object.entries(manifest.provides.services)) {
            if (!svcName.trim()) errors.push('service name cannot be empty');
            if (typeof spec === 'string') {
              if (!parseSemver(spec)) errors.push(`provides.services.${svcName} version must be valid SemVer`);
            } else if (isPlainObject(spec)) {
              if (!parseSemver(spec.version)) errors.push(`provides.services.${svcName}.version must be valid SemVer`);
              if (spec.realm !== undefined && !REALMS.includes(spec.realm)) {
                errors.push(`provides.services.${svcName}.realm must be one of ${REALMS.join(', ')}`);
              }
            } else {
              errors.push(`provides.services.${svcName} must be version string or { version, realm }`);
            }
          }
        }
      }
      for (const topicField of ['events', 'states']) {
        if (manifest.provides[topicField] !== undefined) {
          if (!Array.isArray(manifest.provides[topicField]) || !manifest.provides[topicField].every((t) => typeof t === 'string' && TOPIC_RE.test(t))) {
            errors.push(`provides.${topicField} entries must match "<domain>:<name>@<major>"`);
          }
        }
      }
      if (manifest.provides.surfaces !== undefined) {
        if (!Array.isArray(manifest.provides.surfaces) || !manifest.provides.surfaces.every((s) => typeof s === 'string' && /^[a-z0-9-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(s))) {
          errors.push('provides.surfaces entries must match "<plugin>.<surface>"');
        }
      }
    }
  }

  if (manifest.consumes !== undefined) {
    if (!isPlainObject(manifest.consumes)) {
      errors.push('consumes must be an object');
    } else {
      for (const [depName, spec] of Object.entries(manifest.consumes)) {
        if (typeof spec === 'string') {
          if (!isValidRange(spec)) errors.push(`consumes.${depName} must be a valid SemVer range`);
        } else if (isPlainObject(spec)) {
          if (!isValidRange(spec.version)) errors.push(`consumes.${depName}.version must be a valid SemVer range`);
        } else {
          errors.push(`consumes.${depName} must be a SemVer range or { version, optional }`);
        }
      }
    }
  }

  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) {
      errors.push('permissions must be an array');
    } else {
      for (const p of manifest.permissions) {
        if (!isValidPermission(p)) errors.push(`invalid permission: ${String(p)}`);
      }
    }
  }

  if (manifest.world === 'main' && !(manifest.permissions || []).includes('page:main-world')) {
    errors.push('world="main" requires "page:main-world" permission');
  }

  if (manifest.contributes !== undefined) {
    if (!isPlainObject(manifest.contributes)) {
      errors.push('contributes must be an object');
    } else {
      for (const key of Object.keys(manifest.contributes)) {
        if (!CONTRIBUTION_POINTS.includes(key)) {
          errors.push(`unknown contribution point: ${key}`);
        }
      }
    }
  }

  const hasArtifact = Boolean(
    manifest.main ||
    manifest.renderer ||
    manifest.remote ||
    manifest.contributes?.native ||
    manifest.contributes?.settings
  );
  if (!hasArtifact) {
    errors.push('plugin must declare at least one entry (main/renderer/remote) or native/settings contribution');
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateSettingsSchema(schema) {
  const errors = [];
  if (!isPlainObject(schema) || !Array.isArray(schema.fields)) {
    return { ok: false, errors: ['settings schema must be an object with a fields array'] };
  }
  const seenKeys = new Set();
  for (const field of schema.fields) {
    if (!isPlainObject(field)) {
      errors.push('each field must be an object');
      continue;
    }
    if (typeof field.key !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(field.key)) {
      errors.push(`invalid setting key: ${String(field.key)}`);
    } else if (seenKeys.has(field.key)) {
      errors.push(`duplicate setting key: ${field.key}`);
    } else {
      seenKeys.add(field.key);
    }
    if (!SETTINGS_FIELD_TYPES.includes(field.type)) {
      errors.push(`unsupported setting type for ${field.key}: ${String(field.type)}`);
    }
    if (field.type === 'enum' && (!Array.isArray(field.options) || field.options.length === 0)) {
      errors.push(`enum field ${field.key} must provide non-empty options`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateSettingsValues(schema, rawValues = {}) {
  const schemaCheck = validateSettingsSchema(schema);
  if (!schemaCheck.ok) {
    return { ok: false, errors: schemaCheck.errors, values: {} };
  }
  const input = isPlainObject(rawValues) ? rawValues : {};
  const values = {};
  const errors = [];

  for (const field of schema.fields) {
    const val = input[field.key] !== undefined ? input[field.key] : field.default;
    if (val === undefined) continue;

    if (field.type === 'boolean') {
      if (typeof val !== 'boolean') {
        errors.push(`${field.key} must be boolean`);
      } else {
        values[field.key] = val;
      }
    } else if (field.type === 'string') {
      if (typeof val !== 'string') {
        errors.push(`${field.key} must be string`);
      } else {
        values[field.key] = val;
      }
    } else if (field.type === 'number') {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        errors.push(`${field.key} must be a finite number`);
      } else if (typeof field.min === 'number' && val < field.min) {
        errors.push(`${field.key} must be >= ${field.min}`);
      } else if (typeof field.max === 'number' && val > field.max) {
        errors.push(`${field.key} must be <= ${field.max}`);
      } else {
        values[field.key] = val;
      }
    } else if (field.type === 'enum') {
      const allowed = field.options.map((o) => (isPlainObject(o) ? o.value : o));
      if (!allowed.includes(val)) {
        errors.push(`${field.key} must be one of ${allowed.join(', ')}`);
      } else {
        values[field.key] = val;
      }
    } else if (field.type === 'list') {
      if (!Array.isArray(val)) {
        errors.push(`${field.key} must be an array`);
      } else if (typeof field.maxItems === 'number' && val.length > field.maxItems) {
        errors.push(`${field.key} exceeds maxItems (${field.maxItems})`);
      } else {
        values[field.key] = val;
      }
    }
  }

  return { ok: errors.length === 0, errors, values };
}

function evaluateTrustPolicy(manifest, trustLevel = 'T2', grantedPermissions = []) {
  if (!TRUST_LEVELS.includes(trustLevel)) {
    throw new Error(`Invalid trust level: ${trustLevel}`);
  }
  const declared = Array.isArray(manifest?.permissions) ? Array.from(new Set(manifest.permissions)) : [];
  const approvedSet = new Set(Array.isArray(grantedPermissions) ? grantedPermissions : []);
  const granted = ['fs:plugin-data'];
  const needsConfirmation = [];
  const denied = [];
  const warnings = [];

  for (const perm of declared) {
    if (perm === 'fs:plugin-data') continue;
    if (trustLevel === 'T0') {
      granted.push(perm);
      continue;
    }
    if (trustLevel === 'T1') {
      if (T1_RESTRICTED_PERMISSIONS.includes(perm)) {
        if (approvedSet.has(perm)) {
          granted.push(perm);
        } else {
          needsConfirmation.push(perm);
          denied.push(perm);
        }
      } else {
        granted.push(perm);
        if (isHighRiskPermission(perm) && !approvedSet.has(perm)) {
          needsConfirmation.push(perm);
        }
      }
      continue;
    }
    // T2: 所有高危权限必须由用户逐项明确确认
    if (isHighRiskPermission(perm)) {
      if (approvedSet.has(perm)) {
        granted.push(perm);
      } else {
        needsConfirmation.push(perm);
        denied.push(perm);
      }
    } else {
      granted.push(perm);
    }
  }

  if (trustLevel === 'T2') {
    warnings.push('UNVERIFIED_PLUGIN: T2 插件未经过官方安全审查，高危权限需逐项确认且禁止静默自动更新');
  }
  if (granted.includes('page:main-world')) {
    warnings.push('MAIN_WORLD_FULL_TRUST: 主世界插件可访问页面全局上下文，按插件 token 隔离对其不构成强制边界');
  }

  const canUseMainWorld = manifest?.world === 'main' && granted.includes('page:main-world');
  const world = canUseMainWorld ? 'main' : 'isolated';
  const nodeIsolation = trustLevel === 'T0' ? 'in-process' : 'worker';
  const autoUpdateAllowed = trustLevel !== 'T2';
  const allowed = denied.length === 0;

  return {
    allowed,
    trustLevel,
    badge: trustLevel === 'T2' ? '未审核' : (trustLevel === 'T1' ? '社区已审' : '官方'),
    granted: Array.from(new Set(granted)),
    needsConfirmation: Array.from(new Set(needsConfirmation)),
    denied,
    world,
    nodeIsolation,
    autoUpdateAllowed,
    warnings
  };
}

module.exports = {
  validateManifest,
  validateSettingsSchema,
  validateSettingsValues,
  evaluateTrustPolicy
};
