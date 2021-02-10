/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const http = require('http');
const EventEmitter = require('events');
const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');

const LOG_PREFIX = '[ConnectionManager]';

// Global variables
module.exports = class ConnectionManager {
  constructor (settings, logger) {
    this._bbbGW;
    this._setupBBB();
    this._emitter = this._setupEventEmitter();
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

  _setupEventEmitter() {
    const emitter = new EventEmitter();

    emitter.on(C.WEBSOCKET_MESSAGE, (data) => {
      switch (data.type) {
        case "screenshare":
          this._bbbGW.publish(JSON.stringify(data), C.TO_SCREENSHARE);
          break;
        case "video":
          this._bbbGW.publish(JSON.stringify(data), C.TO_VIDEO);
          break;
        case "audio":
          this._bbbGW.publish(JSON.stringify(data), C.TO_AUDIO);
          break;
        case "default":
          // TODO handle API error message;
      }
    });

    return emitter;
  }

  // Push data to client
  pushMessage (data) {
    this._emitter.emit('response', data);
  }

  async _setupBBB() {
    this._bbbGW = new BigBlueButtonGW();

    try {
      const screenshare = await this._bbbGW.addSubscribeChannel(C.FROM_SCREENSHARE);
      const video = await this._bbbGW.addSubscribeChannel(C.FROM_VIDEO);
      const audio = await this._bbbGW.addSubscribeChannel(C.FROM_AUDIO);
      const push = this.pushMessage.bind(this);

      screenshare.on(C.REDIS_MESSAGE, push);
      video.on(C.REDIS_MESSAGE, push);
      audio.on(C.REDIS_MESSAGE, push);

      Logger.info(LOG_PREFIX, 'Successfully subscribed to processes redis channels');
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Failed to setup connection adapters', {
        errorMessage: error.message,
        errorName: error.name,
      });
      throw error;
    }
  }

  _stopSession(sessionId) {
  }

  _stopAll() {
  }
}
