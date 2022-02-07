/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const EventEmitter = require('events');
const C = require('../bbb/messages/Constants');

// Global variables
module.exports = class ConnectionManager {
  constructor () {
    this._bbbGW;
    this._adapters = [];
  }

  setHttpServer(httpServer) {
    this.httpServer = httpServer;
  }

  listen(callback) {
    this.httpServer.listen(callback);
  }

  addAdapter(adapter) {
    adapter.setEventEmitter(this._emitter);
    this._adapters.push(adapter);
  }

  // Push data to client
  pushMessage (data) {
    this._emitter.emit('response', data);
  }

  setupModuleRouting (modules) {
    this._emitter = new EventEmitter();
    global.CM_ROUTER = this._emitter;

    this._emitter.on(C.CLIENT_REQ, (data) => {
      const { type } = data;
      // Discard if no routing header
      if (type == null) return;
      const module = modules[type];
      if (!module) return;
      module.send(data);
    });

    Object.values(modules).forEach(module => {
      const push = this.pushMessage.bind(this);
      module.onmessage = push;
    });
  }
}
