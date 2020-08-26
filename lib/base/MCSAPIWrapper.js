'use strict'

const config = require('config');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../utils/Logger');
const MCS = require('mcs-js');
const C = require('../bbb/messages/Constants');

const LOG_PREFIX = '[sfu-mcs-api]';
const CONNECTION_TIMEOUT = 10000;

let instance = null;

module.exports = class MCSAPIWrapper extends EventEmitter {
  constructor() {
    if(!instance) {
      super();
      this._mcs = null;
      instance = this;
      this._onClientConnectionError = this._onClientConnectionError.bind(this);
      this._onOpen = this._onOpen.bind(this);
      this.connected = false;
    }

    return instance;
  }

  async start (address, port, secure) {
    this.addr = 'ws://' + address + ':' + port + '/mcs';
    return new Promise((resolve, reject) => {
      try {
        Logger.info("[sfu-mcs-api] Connecting to MCS at", this.addr);
        this._mcs = new MCS(this.addr);
        this._monitorConnectionState();
        this._connectionResolver = resolve;
      } catch(error) {
        Logger.error(`[sfu-mcs-api] Startup MCS connection failed due to ${error.message}`,
          { error });
        resolve();
      }
    })
  }

  _monitorConnectionState () {
    this._mcs.once('error', this._onClientConnectionError)
    this._mcs.once('close', this._onClientConnectionError)
    this._mcs.once('open', this._onOpen);
  }

  _onOpen () {
    Logger.info("[sfu-mcs-api] Connected to MCS");
    if (this._reconnectionRoutine) {
      clearInterval(this._reconnectionRoutine);
      this._reconnectionRoutine = null;
    }

    this._mcs.on('error', this._onClientConnectionError);
    this._mcs.once('close', this._onClientConnectionError);
    this.emit(C.MCS_CONNECTED);
    this.connected = true;
    this._connectionResolver();
  }

  _onDisconnection () {
    // TODO base reconenction, should be ane exponential backoff
    if (this._reconnectionRoutine == null) {
      this.emit(C.MCS_DISCONNECTED);
      this.connected = false;
      this._reconnectionRoutine = setInterval(async () => {
        try {
          Logger.info("[sfu-mcs-api] Trying to reconnect to MCS at", this.addr);
          this._mcs = new MCS(this.addr);
          this._monitorConnectionState()
        } catch (err) {
          Logger.warn("[sfu-mcs-api] Failed to reconnect to MCS]");
          delete this._mcs;
        }
      }, 2000);
    }
  }

  _onClientConnectionError (error) {
    if (error) {
    Logger.error(LOG_PREFIX, `SFU socket connection to mcs-core failed due to ${error.message}`,
      { message: error.message, code: error.code });
    } else {
      Logger.error(LOG_PREFIX, `SFU socket connection to mcs-core closed unexpectedly`);
    }
    this._onDisconnection();
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

  async leave (room, user, params = {}) {
    try {
      const answer = await this._mcs.leave(user, room, params);
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
      await this._mcs.unpublish(user, mediaId);
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
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'unsubscribe', { user, mediaId }));
    }
  }

  async startRecording(userId, mediaId, recordingPath, options) {
    try {
      const { recordingId } = await this._mcs.startRecording(userId, mediaId, recordingPath, options);
      return recordingId;
    }
    catch (error) {
      throw (this._handleError(error, 'startRecording', { userId, mediaId, recordingPath}));
    }
  }

  async stopRecording(userId, recId) {
    try {
      const { recordingId } = await this._mcs.stopRecording(userId, recId);
      return recordingId;
    }
    catch (error) {
      throw (this._handleError(error, 'stopRecording', { userId, recId }));
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
      throw (this._handleError(error, 'disconnect', { source, sinks, type }));
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

  async setContentFloor (roomId, mediaId) {
    try {
      return this._mcs.setContentFloor(roomId, mediaId);
    }
    catch (error) {
      throw (this._handleError(error, 'setContentFloor', { roomId, mediaId }));
    }
  }

  async getContentFloor (roomId) {
    try {
      const ret = await this._mcs.getContentFloor(roomId);
      return ret;
    }
    catch (error) {
      throw (this._handleError(error, 'getContentFloor', { roomId }));
    }
  }

  async releaseContentFloor (roomId) {
    try {
      return this._mcs.releaseContentFloor(roomId);
    }
    catch (error) {
      throw (this._handleError(error, 'releaseContentFloor', { roomId }));
    }
  }


  async setConferenceFloor (roomId, mediaId) {
    try {
      return this._mcs.setConferenceFloor(roomId, mediaId);
    }
    catch (error) {
      throw (this._handleError(error, 'setConferenceFloor', { roomId, mediaId }));
    }
  }

  async releaseConferenceFloor(roomId) {
    try {
      return this._mcs.releaseConferenceFloor(roomId);
    }
    catch (error) {
      throw (this._handleError(error, 'releaseConferenceFloor', { roomId }));
    }
  }

  async getMedias (memberType, identifier, options = {}) {
    try {
      const mediaInfo = await this._mcs.getMedias(memberType, identifier, options);
      return mediaInfo;
    }
    catch (error) {
      throw (this._handleError(error, 'getMedias', { memberType, identifier, options }));
    }
  }

  setStrategy (strategy) {
    // TODO
  }

  waitForConnection () {
    const onConnected = () => {
      return new Promise((resolve) => {
        if (this.connected) {
          return resolve(true);
        }
        this.once(C.MCS_CONNECTED, () => {
          return resolve(true);
        });
      });
    }

    const failOver = () => {
      return new Promise((resolve) => {
        setTimeout(() => {
          return resolve(false)
        }, CONNECTION_TIMEOUT);
      });
    };

    return Promise.race([onConnected(), failOver()]);
  }

  _handleError (error, operation) {
    let response;
    if (error.response == null) {
      error.details = error.message;
      error.response = error;
    }
    const { code, message, details, stack } = error.response;
    response = { type: 'error', code, message, details, stack, operation };
    return response;
  }
}
