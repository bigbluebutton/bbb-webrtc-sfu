'use strict';

const { hrTime } = require('../utils/util.js');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter.js');

class BaseEvent {
  constructor(tag, scope) {
    this.tag = tag;
    this.scope = scope;
    this.timestampUTC = Date.now();
    this.timestampHR = hrTime();
  }

  getPayload () {
    const payload = {};
    Object.getOwnPropertyNames(this).forEach(k => {
      payload[k] = this[k];
    });

    return payload;
  }

  getEventName () {
    if (this.scope) {
      return `${this.tag}:${this.scope}`
    }

    return this.tag;
  }

  fire () {
    const payload = this.getPayload();
    const name = this.getEventName();
    GLOBAL_EVENT_EMITTER.emit(name, payload);
    GLOBAL_EVENT_EMITTER.emit(this.tag, payload);
  }
}

module.exports = BaseEvent;
