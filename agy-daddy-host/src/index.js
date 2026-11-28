'use strict';

module.exports = {
  constants: require('./contracts/constants'),
  semver: require('./contracts/semver'),
  validator: require('./contracts/manifest-validator'),
  paths: require('./core/paths'),
  storage: require('./core/storage'),
  runtimeResolver: require('./core/runtime-resolver'),
  cdp: require('./core/cdp'),
  rpc: require('./core/rpc'),
  bus: require('./core/bus'),
  bridge: require('./core/bridge'),
  anchors: require('./core/anchors'),
  injector: require('./core/injector'),
  installer: require('./core/installer'),
  updateChecker: require('./core/update-checker'),
  updater: require('./core/updater'),
  updaterHelper: require('./core/updater-helper'),
  customizations: require('./core/customizations'),
  marketplaceStats: require('./core/marketplace-stats'),
  doctor: require('./core/doctor'),
  daemon: require('./core/daemon'),
  lifecycle: require('./core/lifecycle'),
  trayManager: require('./core/tray-manager'),
  launcher: require('./core/launcher')
};
