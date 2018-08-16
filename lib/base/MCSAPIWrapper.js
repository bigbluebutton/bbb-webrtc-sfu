'use strict'

const config = require('config');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../utils/Logger');
const MCS = require('mcs-js');
const C = require('../bbb/messages/Constants');

let instance = null;

module.exports = class MCSAPIWrapper extends EventEmitter {
  constructor() {
    if(!instance) {
      super();
      this._mcs = null;
      instance = this;
    }

    return instance;
  }

  async start (address, port, secure) {
    const self = this;
    return new Promise((resolve, reject) => {
      try {
        const addr = 'ws://' + address + ':' + port + '/mcs';
        Logger.info("[sfu-mcs-api] Connecting to MCS at", addr);
        const client = new MCS(addr);
        client.on('open', () => {
          this._mcs = client;
          Logger.info("[sfu-mcs-api] Connected to MCS.");
          resolve();
        });

        client.on(C.MEDIA_STATE, (args) => {
          Logger.info("[sfu-mcs-api] Received media state event", args);
          const { mediaId, state } = args;
          self.emit(C.MEDIA_STATE, { mediaId, state });
        });

        client.on(C.MEDIA_STATE_ICE, (args) => {
          Logger.info("[sfu-mcs-api] Received onIceCandidate event", args);
          const { mediaId, candidate } = args;
          self.emit(C.MEDIA_STATE_ICE, { mediaId, candidate });
        });

      } catch(error) {
        throw (this._handleError(error, 'start', arguments));
      }
    })
  }

  async join (room, type, params) {
    try {
      const { user_id } = await this._mcs.join(room, type, params);
      return user_id;
    }
    catch (error) {
      throw (this._handleError(error, 'join', { room, type, params}));
    }
  }

  async leave (room, user) {
    try {
      const answer = await this._mcs.leave(user, room);
      //const answer = await this._mediaController.leave(room, user);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'leave', { room, user }));
    }
  }

  async publishnsubscribe (room, user, sourceId, type, params) {
    try {
      const answer = await this._mcs.publishAndSubscribe(room, user, sourceId, type, params);
      //const answer = await this._mediaController.publishnsubscribe(user, sourceId, sdp, params);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'publishnsubscribe', { room, user, sourceId, type, params }));
    }
  }

  async publish (user, room,  type, params) {
    try {
      const { mediaId, descriptor } = await this._mcs.publish(user, room, type, params);
      return  { mediaId, answer: descriptor };
    }
    catch (error) {
      throw (this._handleError(error, 'publish', { user, room, type, params }));
    }
  }

  async unpublish (user, mediaId) {
    try {
      await this._mcs.unpublish(mediaId);
      //await this._mediaController.unpublish(mediaId);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'unpublish', { user, mediaId }));
    }
  }

  async subscribe (user, sourceId, type, params) {
    try {
      const { mediaId, descriptor } = await this._mcs.subscribe(user, sourceId, type, params);
      return { mediaId, answer: descriptor };
    }
    catch (error) {
      throw (this._handleError(error, 'subscribe', { user, sourceId, type, params }));
    }
  }

  async unsubscribe (user, mediaId) {
    try {
      await this._mcs.unsubscribe(user, mediaId);
      //await this._mediaController.unsubscribe(user, mediaId);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'unsubscribe', { user, mediaId }));
    }
  }

  async startRecording(userId, mediaId, recordingPath) {
    try {
      const answer = await this._mcs.startRecording(userId, mediaId, recordingPath);
      //const answer = await this._mediaController.startRecording(userId, mediaId, recordingPath);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'startRecording', { userId, mediaId, recordingPath}));
    }
  }

  async stopRecording(userId, sourceId, recId) {
    try {
      const answer = await this._mcs.stopRecording(userId, sourceId, recId);
      //const answer = await this._mediaController.stopRecording(userId, sourceId, recId);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'stopRecording', { userId, sourceId, recId }));
    }
  }

  async connect (source, sinks, type) {
    try {
      await this._mcs.connect(source, sinks, type);
      //await this._mediaController.connect(source, sink, type);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'connect', { source, sink, type }));
    }
  }

  async disconnect (source, sinks, type) {
    try {
      await this._mcs.disconnect(source, sinks, type);
      //await this._mediaController.disconnect(source, sink, type);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'disconnect', { source, sink, type }));
    }
  }

  async onEvent (eventName, identifier, callback) {
    try {
      this._mcs.onEvent(eventName, identifier, callback);
    }
    catch (error) {
      throw (this._handleError(error, 'onEvent', { ...arguments }));
    }
  }

  async addIceCandidate (mediaId, candidate) {
    try {
      const ack = await this._mcs.addIceCandidate(mediaId, candidate);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'addIceCandidate', { mediaId, candidate }));
    }
  }

  setStrategy (strategy) {
    // TODO
  }

  _handleError (error, operation, params) {
    const { code, message, details, stack } = error;
    const response = { type: 'error', code, message, details, stack, operation, params };
    Logger.error("[mcs-api] Reject operation", response.operation, "with", { error: response });

    return response;
  }
}
