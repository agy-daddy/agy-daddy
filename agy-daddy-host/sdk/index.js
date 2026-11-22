'use strict';

const constants = require('../src/contracts/constants');
const semver = require('../src/contracts/semver');
const validator = require('../src/contracts/manifest-validator');
const mockHarness = require('./mock-harness');
const createPlugin = require('./create-plugin');

module.exports = {
  ...constants,
  ...semver,
  ...validator,
  ...mockHarness,
  ...createPlugin
};
