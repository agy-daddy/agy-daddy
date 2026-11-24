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
const STRING_EDITOR_MODES = Object.freeze(['markdown-modal', 'shortcut']);

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
    if (field.type === 'string') {
      if (field.options !== undefined) {
        if (!Array.isArray(field.options)) {
          errors.push(`options for ${field.key} must be an array`);
        } else {
          for (const opt of field.options) {
            const validOpt = typeof opt === 'string' || (isPlainObject(opt) && typeof opt.value === 'string');
            if (!validOpt) {
              errors.push(`options for ${field.key} must contain strings or { value, label } objects`);
              break;
            }
          }
        }
      }
      if (field.optionsCommand !== undefined && (typeof field.optionsCommand !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(field.optionsCommand))) {
        errors.push(`invalid optionsCommand for ${field.key}: ${String(field.optionsCommand)}`);
      }
      if (field.multiline !== undefined && typeof field.multiline !== 'boolean') {
        errors.push(`multiline for ${field.key} must be boolean`);
      }
      if (field.rows !== undefined && (!Number.isInteger(field.rows) || field.rows < 2 || field.rows > 20)) {
        errors.push(`rows for ${field.key} must be an integer between 2 and 20`);
      }
      if (field.resetToDefault !== undefined && typeof field.resetToDefault !== 'boolean') {
        errors.push(`resetToDefault for ${field.key} must be boolean`);
      }
      if (field.editorMode !== undefined && (typeof field.editorMode !== 'string' || !STRING_EDITOR_MODES.includes(field.editorMode))) {
        errors.push(`editorMode for ${field.key} must be one of: ${STRING_EDITOR_MODES.join(', ')}`);
      }
      if (field.openButtonLabel !== undefined && typeof field.openButtonLabel !== 'string' && !isPlainObject(field.openButtonLabel)) {
        errors.push(`openButtonLabel for ${field.key} must be a string or locale object`);
      }
      if (field.modalTitle !== undefined && typeof field.modalTitle !== 'string' && !isPlainObject(field.modalTitle)) {
        errors.push(`modalTitle for ${field.key} must be a string or locale object`);
      }
      if (field.composer !== undefined) {
        const cp = field.composer;
        if (!isPlainObject(cp) || typeof cp.command !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(cp.command)) {
          errors.push(`composer for ${field.key} must be an object with a valid command`);
        } else {
          if (cp.watchKeys !== undefined && (!Array.isArray(cp.watchKeys) || !cp.watchKeys.every((k) => typeof k === 'string' && k.trim()))) {
            errors.push(`composer.watchKeys for ${field.key} must be an array of non-empty strings`);
          }
          if (cp.resetLabel !== undefined && typeof cp.resetLabel !== 'string' && !isPlainObject(cp.resetLabel)) {
            errors.push(`composer.resetLabel for ${field.key} must be a string or locale object`);
          }
          if (cp.runOnOpen !== undefined && typeof cp.runOnOpen !== 'boolean') {
            errors.push(`composer.runOnOpen for ${field.key} must be boolean`);
          }
        }
      }
    }
    if (field.type === 'list' && field.itemEditor?.kind === 'ordered-preset-list') {
      const ie = field.itemEditor;
      if (ie.presets !== undefined) {
        if (!Array.isArray(ie.presets)) {
          errors.push(`itemEditor.presets for ${field.key} must be an array`);
        } else {
          for (const preset of ie.presets) {
            if (!isPlainObject(preset) || typeof preset.id !== 'string' || !preset.id.trim()) {
              errors.push(`itemEditor.presets entries for ${field.key} must have a non-empty string id`);
              break;
            }
          }
        }
      }
      if (ie.allowCustom !== undefined && typeof ie.allowCustom !== 'boolean') {
        errors.push(`itemEditor.allowCustom for ${field.key} must be boolean`);
      }
      if (ie.dynamicPresetsCommand !== undefined && (typeof ie.dynamicPresetsCommand !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(ie.dynamicPresetsCommand))) {
        errors.push(`itemEditor.dynamicPresetsCommand for ${field.key} must be a valid command string`);
      }
      if (ie.dynamicAction !== undefined) {
        const da = ie.dynamicAction;
        const daLabelValid = isPlainObject(da) && (
          (typeof da.label === 'string' && da.label.trim().length > 0)
          || (isPlainObject(da.label) && Object.values(da.label).some((v) => typeof v === 'string' && v.trim().length > 0))
        );
        if (!isPlainObject(da) || typeof da.command !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(da.command) || !daLabelValid) {
          errors.push(`itemEditor.dynamicAction for ${field.key} must have a valid command and non-empty label`);
        }
      }
      if (ie.dynamicPoolTitle !== undefined && typeof ie.dynamicPoolTitle !== 'string' && !isPlainObject(ie.dynamicPoolTitle)) {
        errors.push(`itemEditor.dynamicPoolTitle for ${field.key} must be a string or localized object`);
      }
      if (ie.dynamicEmptyHint !== undefined && typeof ie.dynamicEmptyHint !== 'string' && !isPlainObject(ie.dynamicEmptyHint)) {
        errors.push(`itemEditor.dynamicEmptyHint for ${field.key} must be a string or localized object`);
      }
    }
    if (field.type === 'list' && field.itemEditor?.kind === 'catalog-filter-sort') {
      const ie = field.itemEditor;
      if (typeof ie.itemsCommand !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(ie.itemsCommand)) {
        errors.push(`itemEditor.itemsCommand for ${field.key} must be a valid command string`);
      }
      if (ie.sortModeKey !== undefined && (typeof ie.sortModeKey !== 'string' || !ie.sortModeKey.trim())) {
        errors.push(`itemEditor.sortModeKey for ${field.key} must be a non-empty string`);
      }
      if (ie.filterDimensions !== undefined) {
        if (!Array.isArray(ie.filterDimensions) || !ie.filterDimensions.every((d) => isPlainObject(d) && typeof d.id === 'string' && d.id.trim())) {
          errors.push(`itemEditor.filterDimensions for ${field.key} must be an array of { id, label } objects`);
        }
      }
      if (ie.sortOptions !== undefined) {
        if (!Array.isArray(ie.sortOptions) || !ie.sortOptions.every((o) => isPlainObject(o) && typeof o.value === 'string' && o.value.trim())) {
          errors.push(`itemEditor.sortOptions for ${field.key} must be an array of { value, label } objects`);
        }
      }
    }
    if (field.browse !== undefined) {
      if (field.type !== 'string' && field.type !== 'list') {
        errors.push(`browse for ${field.key} is only supported for string or list fields`);
      } else {
        const br = field.browse;
        if (!isPlainObject(br) || typeof br.command !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(br.command)) {
          errors.push(`browse for ${field.key} must be an object with a valid command`);
        } else if (br.label !== undefined && typeof br.label !== 'string' && !isPlainObject(br.label)) {
          errors.push(`browse.label for ${field.key} must be a string or locale object`);
        }
      }
    }
    if (field.probe !== undefined) {
      const pr = field.probe;
      if (!isPlainObject(pr) || typeof pr.command !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(pr.command)) {
        errors.push(`probe for ${field.key} must be an object with a valid command`);
      } else {
        if (pr.watchKeys !== undefined && (!Array.isArray(pr.watchKeys) || !pr.watchKeys.every((k) => typeof k === 'string' && k.trim()))) {
          errors.push(`probe.watchKeys for ${field.key} must be an array of non-empty strings`);
        }
        if (pr.autoFill !== undefined && typeof pr.autoFill !== 'boolean') {
          errors.push(`probe.autoFill for ${field.key} must be boolean`);
        }
        if (pr.runOnOpen !== undefined && typeof pr.runOnOpen !== 'boolean') {
          errors.push(`probe.runOnOpen for ${field.key} must be boolean`);
        }
        if (pr.onlyWhenTruthy !== undefined && typeof pr.onlyWhenTruthy !== 'boolean') {
          errors.push(`probe.onlyWhenTruthy for ${field.key} must be boolean`);
        }
      }
    }
    if (field.guide !== undefined) {
      const g = field.guide;
      if (!isPlainObject(g)) {
        errors.push(`guide for ${field.key} must be an object`);
      } else {
        if (g.steps !== undefined && !Array.isArray(g.steps)) {
          errors.push(`guide.steps for ${field.key} must be an array`);
        }
        if (g.commands !== undefined && !Array.isArray(g.commands)) {
          errors.push(`guide.commands for ${field.key} must be an array`);
        }
        if (g.links !== undefined && !Array.isArray(g.links)) {
          errors.push(`guide.links for ${field.key} must be an array`);
        }
      }
    }
    if (field.secret !== undefined && typeof field.secret !== 'boolean') {
      errors.push(`secret for ${field.key} must be boolean`);
    }
    if (field.writeOnly !== undefined && typeof field.writeOnly !== 'boolean') {
      errors.push(`writeOnly for ${field.key} must be boolean`);
    }
    if (field.visibleWhen !== undefined) {
      const vw = field.visibleWhen;
      const hasCondition = isPlainObject(vw) && (
        Object.prototype.hasOwnProperty.call(vw, 'equals') ||
        Object.prototype.hasOwnProperty.call(vw, 'notEquals') ||
        (Array.isArray(vw.in) && vw.in.length > 0)
      );
      if (!isPlainObject(vw) || typeof vw.key !== 'string' || !vw.key.trim() || !hasCondition) {
        errors.push(`visibleWhen for ${field.key} must be an object with key and equals/notEquals/in`);
      }
    }
  }
  if (schema.actions !== undefined) {
    if (!Array.isArray(schema.actions)) {
      errors.push('settings schema actions must be an array');
    } else {
      const seenActionIds = new Set();
      for (const action of schema.actions) {
        if (!isPlainObject(action)) {
          errors.push('each setting action must be an object');
          continue;
        }
        if (typeof action.id !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(action.id)) {
          errors.push(`invalid setting action id: ${String(action.id)}`);
        } else if (seenActionIds.has(action.id)) {
          errors.push(`duplicate setting action id: ${action.id}`);
        } else {
          seenActionIds.add(action.id);
        }
        if (typeof action.command !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(action.command)) {
          errors.push(`invalid setting action command for ${String(action.id)}: ${String(action.command)}`);
        }
        const labelValid = (typeof action.label === 'string' && action.label.trim().length > 0) ||
          (isPlainObject(action.label) && Object.values(action.label).some((v) => typeof v === 'string' && v.trim().length > 0));
        if (!labelValid) {
          errors.push(`setting action ${String(action.id)} must provide a non-empty label`);
        }
        if (action.args !== undefined && !Array.isArray(action.args)) {
          errors.push(`setting action ${String(action.id)} args must be an array`);
        }
      }
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

function redactWriteOnlySettings(schema, rawValues = {}) {
  const out = isPlainObject(rawValues) ? { ...rawValues } : {};
  const secretState = {};
  if (schema && Array.isArray(schema.fields)) {
    for (const field of schema.fields) {
      if (!field || !field.key || field.writeOnly !== true) continue;
      const cur = out[field.key];
      const configured = typeof cur === 'string' ? cur.trim().length > 0 : Boolean(cur);
      secretState[field.key] = configured;
      out[field.key] = '';
    }
  }
  return { values: out, secretState };
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
  redactWriteOnlySettings,
  evaluateTrustPolicy
};
