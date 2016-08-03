/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the 'License'). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

/* global TelemetryController */

const {Cu} = require('chrome');

Cu.import('resource://gre/modules/TelemetryController.jsm');

const { setTimeout, clearTimeout } = require('sdk/timers');
const Events = require('sdk/system/events');
const PrefsService = require('sdk/preferences/service');
const self = require('sdk/self');
const store = require('sdk/simple-storage').storage;

const seedrandom = require('seedrandom');

// Event type for receiving pings from experiments
const EVENT_SEND_METRIC = 'testpilot::send-metric';
const EVENT_RECEIVE_VARIANT_DEFS = 'testpilot::register-variants';
const EVENT_SEND_VARIANTS = 'testpilot::receive-variants';

// List of preferences we'll override on install & restore on uninstall
const PREFERENCE_OVERRIDES = {
  'toolkit.telemetry.enabled': true,
  'datareporting.healthreport.uploadEnabled': true
};

//
TELEMETRY_TESTPILOT = 'testpilot';
TELEMETRY_EXPERIMENT = 'testpilottest';

let pingTimer = null;

const variantMaker = {
  makeTest: function(test) {
    let summedWeight = 0;
    const variants = [];
    test.variants.forEach(variant => {
      summedWeight += variant.weight;
      for (let i = 0; i < variant.weight; i++) {
        variants.push(variant.value);
      }
    });
    const seed = `${test.name}_${store.clientUUID}`;
    return variants[Math.floor(seedrandom(seed)() * summedWeight)];
  },

  parseTests: function(tests) {
    const results = {};
    Object.keys(tests).forEach(key => {
      results[key] = this.makeTest(tests[key]);
    });
    return results;
  }
};


const Metrics = module.exports = {

  init: function() {
    store.browserLoadedTimestamp = Date.now();

    Events.on(EVENT_SEND_METRIC, Metrics.onExperimentPing);
    Events.on(EVENT_RECEIVE_VARIANT_DEFS, Metrics.onReceiveVariantDefs);
  },

  onEnable: function() {
    Metrics.prefs.backup();
  },

  onDisable: function() {
    Metrics.prefs.restore();
  },

  prefs: {
    // Backup existing preference settings and then override.
    backup: function() {
      store.metricsPrefsBackup = {};
      Object.keys(PREFERENCE_OVERRIDES).forEach(name => {
        store.metricsPrefsBackup[name] = PrefsService.get(name);
        PrefsService.set(name, PREFERENCE_OVERRIDES[name]);
      });
    },

    // Restore previous preference settings before override.
    restore: function() {
      if (store.metricsPrefsBackup) {
        Object.keys(PREFERENCE_OVERRIDES).forEach(name => {
          PrefsService.set(name, store.metricsPrefsBackup[name]);
        });
      }
    }
  },

  destroy: function() {
    Events.off(EVENT_SEND_METRIC, Metrics.onExperimentPing);
  },

  pingTelemetry: function() {
    TelemetryController.submitExternalPing(
      TELEMETRY_TESTPILOT,
      store.telemetryPingPayload,
      { addClientId: true, addEnvironment: true }
    );
  },

  updateExperiment: function(addonId, data) {
    store.telemetryPingPayload.tests[addonId] = Object.assign(
      store.telemetryPingPayload.tests[addonId] || {},
      data
    );
  },

  experimentEnabled: function(addonId) {
    Metrics.updateExperiment(addonId, {last_enabled: Date.now()});
  },

  experimentDisabled: function(addonId) {
    Metrics.updateExperiment(addonId, {last_disabled: Date.now()});
  },

  experimentFeaturesChanged: function(addonId, features) {
    Metrics.updateExperiment(addonId, {features: features});
  },

  onReceiveVariantDefs: function(ev) {
    if (!store.experimentVariants) {
      store.experimentVariants = {};
    }

    const { subject, data } = ev;
    const dataParsed = variantMaker.parseTests(JSON.parse(data));

    store.experimentVariants[subject] = dataParsed;
    Metrics.experimentFeaturesChanged(subject, dataParsed);
    Events.emit(EVENT_SEND_VARIANTS, {
      data: JSON.stringify(dataParsed),
      subject: self.id
    });
  },

  onExperimentPing: function(ev) {
    const { subject, data } = ev;
    const dataParsed = JSON.parse(data);

    if (store.experimentVariants && subject in store.experimentVariants) {
      dataParsed.variants = store.experimentVariants[subject];
    }

    const payload = {
      version: 1,
      test: subject,
      payload: dataParsed
    };

    TelemetryController.submitExternalPing(
      TELEMETRY_EXPERIMENT, payload,
      { addClientId: true, addEnvironment: true }
    );
  }

};
