'use strict';

const config = require('config');
const Logger = require('../utils/logger');
const EventEmitter = require('events').EventEmitter;
const C = require('../constants/constants');
const Balancer = require('../media/balancer');
// Media server adapters
const configuredAdapters = config.get('media-server-adapters');
const adapterPathPrefix = './';
// Preset configured adapters
const defaultAdapters = {'contentAdapter': 'Kurento', 'videoAdapter': 'Kurento', 'audioAdapter': 'Freeswitch'};


let instance = null;

class AdapterFactory extends EventEmitter {
  constructor () {
    super();
    if (instance == null) {
      instance = this;
      this.adapters = [];
      configuredAdapters.forEach(a => {
        try {
          const { path, name } = a;
          const adapter = require(`${adapterPathPrefix}${path}`);
          this.adapters.push({ adapter, name });
        } catch (e) {
          Logger.error('[mcs-adapter-factory] Could not add configured adapter', a, e);
        }
      });

      Logger.info('[mcs-adapter-factory] Configured media server adapters', this.adapters, this.adapters.map(a => a.name));
    }
    return instance;
  }

  isComposedAdapter (adapter) {
    if (typeof adapter === 'object') {
      return true;
    }

    return false;
  }

  findAdapter (adapterName) {
    let adapter = null;
    const adapterObj = this.adapters.find(a => a.name === adapterName);
    if (adapterObj) {
      const aConstructor = adapterObj.adapter;
      adapter = new aConstructor(Balancer);
    }

    return adapter;
  }

  getAdapters (adapterReq) {
    let adapters = {};
    let defaultAdaptersMap = { ... defaultAdapters };

    const findComposedAdapters = (aMap) => {
      Object.keys(aMap).forEach(r => {
        const a = this.findAdapter(aMap[r]);
        if (a) {
          adapters[r] = a;
          delete defaultAdaptersMap[r];
        }
      });
    };

    if (this.isComposedAdapter(adapterReq)) {
      findComposedAdapters(adapterReq);
      findComposedAdapters(defaultAdaptersMap);
      return adapters;
    } else {
      const a = this.findAdapter(adapterReq);
      return {'videoAdapter': a, 'audioAdapter': a, 'contentAdapter': a};
    }
  }
}

module.exports = new AdapterFactory();
