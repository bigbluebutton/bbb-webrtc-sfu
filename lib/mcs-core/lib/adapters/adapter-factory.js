'use strict';

const config = require('config');
const Logger = require('../utils/logger');
const EventEmitter = require('events').EventEmitter;
const C = require('../constants/constants');
const Balancer = require('../media/balancer');

const LOG_PREFIX = '[mcs-adapter-factory]';
// Media server adapters
const CONFIGURED_ADAPTERS= config.get('media-server-adapters');
const ADAPTER_PATH_PREFIX = './';

// Preset configured adapters
const DEFAULT_ADAPTERS = {'contentAdapter': 'Kurento', 'videoAdapter': 'Kurento', 'audioAdapter': 'Freeswitch'};

let instance = null;

class AdapterFactory extends EventEmitter {
  constructor () {
    super();
    if (instance == null) {
      instance = this;
      this.adapters = [];
      CONFIGURED_ADAPTERS.forEach(a => {
        try {
          const { path, name } = a;
          const adapterConstructor = require(`${ADAPTER_PATH_PREFIX}${path}`);
          const instance = new adapterConstructor(name, Balancer);
          this.adapters.push({ adapter: instance, name });
        } catch (e) {
          Logger.error(LOG_PREFIX, 'Could not add configured adapter', a, e);
        }
      });

      Logger.info(LOG_PREFIX, 'Configured media server adapters:', this.adapters.map(a => a.name));
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
      adapter = adapterObj.adapter;
    }

    return adapter;
  }

  getAdapters (adapterReq) {
    let adapters = {};
    let defaultAdaptersMap = { ...DEFAULT_ADAPTERS };

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
