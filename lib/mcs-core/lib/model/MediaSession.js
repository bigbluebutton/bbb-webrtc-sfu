/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/Constants');
const rid = require('readable-id');
const Kurento = require('../adapters/kurento/kurento');
const Freeswitch = require('../adapters/freeswitch/freeswitch');
const config = require('config');
const kurentoUrl = config.get('kurentoUrl');
const Logger = require('../../../utils/Logger');
const { handleError } = require('../utils/util');
const LOG_PREFIX = "[mcs-media-session]";

module.exports = class MediaSession {
  constructor (
    emitter,
    room,
    user,
    type = 'WebRtcEndpoint',
    options = {}
  ) {
    this.id = rid();
    this.roomId = room;
    this.userId = user;
    this.emitter = emitter;
    this._options = options;
    // State indicator of this session. Might be STOPPED, STARTING or STARTED
    this._status = C.STATUS.STOPPED;
    // Signalling or transport layer type
    this._type = type;
    // Readable name for this session, provided by clients
    this._name = options.name? options.name : C.STRING.DEFAULT_NAME;
    // Media server adapter, falls back to Kurento
    this._adapter = options.adapter? options.adapter : C.STRING.KURENTO;
    // Media server interface based on given adapter
    this._MediaServer = MediaSession.getAdapter(this._adapter);
    // Media server adapter ID for this session's element
    this._mediaElement;
    // Array of media sessions that are subscribed to this feed
    this.subscribedSessions = [];
    // An object that describes the capabilities of this media session
    this._mediaTypes = {
      video: false,
      audio: false,
      text: false,
      application: false,
      message: false,
    }
    this._muted = false;
    // API event buffers for this media session
    this.eventQueue = [];
    this.outboundIceQueue = [];
    this._mediaStateSubscription = false;
    this._iceSubscription = false;
  }

  static getAdapter (adapter) {
    let obj = null;

    Logger.info("[mcs-media-session] Session is using the", adapter, "adapter");

    switch (adapter) {
      case C.STRING.KURENTO:
        obj = new Kurento(kurentoUrl);
        break;
      case C.STRING.FREESWITCH:
        obj = new Freeswitch();
        break;
      default: Logger.warn("[mcs-media-session] Invalid adapter", this.adapter); }

    return obj;
  }

  async start () {
    this._status = C.STATUS.STARTING;
    try {
      const client = await this._MediaServer.init();

      this._mediaElement = await this._MediaServer.createMediaElement(this.roomId, this._type, this._options);

      Logger.info("[mcs-media-session] New media session", this.id, "in room", this.roomId, "started with media server endpoint", this._mediaElement);

      this._MediaServer.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT+this._mediaElement, this._dispatchMediaStateEvent.bind(this));
      this._MediaServer.on(C.EVENT.MEDIA_STATE.ICE+this._mediaElement, this._dispatchIceCandidate.bind(this));

      this._MediaServer.trackMediaState(this._mediaElement, this._type);

      this._MediaServer.on(C.ERROR.MEDIA_SERVER_OFFLINE, () => {
        let event = {};
        event.state = C.ERROR.MEDIA_SERVER_OFFLINE;
        event.mediaId = this.id;
        this.emitter.emit(C.EVENT.SERVER_STATE, event);
      });

      this._MediaServer.on(C.EVENT.MEDIA_SERVER_ONLINE, () => {
        let event = {};
        event.state = C.EVENT.MEDIA_SERVER_ONLINE;
        event.mediaId = this.id;
        this.emitter.emit(C.EVENT.SERVER_STATE, event);
      });

      return Promise.resolve(this._mediaElement);
    }
    catch (err) {
      err = this._handleError(err);
      return Promise.reject(err);
    }
  }

  async stop () {
    if (this._status === C.STATUS.STARTED) {
      this._status = C.STATUS.STOPPING;
      try {
        await this._MediaServer.stop(this.roomId, this._type, this._mediaElement);
        this._status = C.STATUS.STOPPED;
        Logger.info("[mcs-media-session] Session", this.id, "stopped with status", this._status);
        this.emitter.emit(C.EVENT.MEDIA_DISCONNECTED, this.id);
        return Promise.resolve();
      }
      catch (err) {
        err = this._handleError(err);
        return Promise.reject(err);
      }
    } else {
      return Promise.resolve();
    }
  }

  async connect (sinkId, type = 'ALL') {
    try {
      Logger.info("[mcs-media-session] Connecting " + this._mediaElement + " => " + sinkId);
      await this._MediaServer.connect(this._mediaElement, sinkId, type);
      return Promise.resolve();
    }
    catch (err) {
      err = this._handleError(err);
      return Promise.reject(err);
    }
  }

  async disconnect (sinkId, type = 'ALL') {
    try {
      Logger.info("[mcs-media-session] Dis-connecting " + this._mediaElement + " => " + sinkId);
      await this._MediaServer.disconnect(this._mediaElement, sinkId, type);
      return Promise.resolve();
    }
    catch (err) {
      err = this._handleError(err);
      return Promise.reject(err);
    }
  }

  sessionStarted () {
    if (this._status === C.STATUS.STARTING) {
      this._status = C.STATUS.STARTED;
      Logger.debug("[mcs-media-session] Session", this.id, "successfully started");
    }
  }

  onEvent (eventName) {
    switch (eventName) {
      case C.EVENT.MEDIA_STATE.MEDIA_EVENT:
        this._mediaStateSubscription = true;
        this._flushMediaStateEvents();
        break;
      case C.EVENT.MEDIA_STATE.ICE:
        this._iceSubscription = true;
        this._flushIceEvents();
        break;
      default: Logger.trace("[mcs-media-session] Unknown event subscription", eventName);
    }

  }

  _dispatchMediaStateEvent (event) {
    event.mediaId = this.id;
    if (!this._mediaStateSubscription) {
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", event);
      this.eventQueue.push(event);
    }
    else {
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _dispatchIceCandidate (event) {
    event.mediaId = this.id;
    if (!this._iceSubscription) {
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", event);
      this.outboundIceQueue.push(event);
    }
    else {
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  _flushMediaStateEvents () {
    Logger.debug("[mcs-media-session] Flushing session", this.id, "media state queue");

    while (this.eventQueue.length) {
      const event = this.eventQueue.shift();
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _flushIceEvents () {
    Logger.debug("[mcs-media-session] Flushing session", this.id, "ICE queue");

    while (this.outboundIceQueue.length) {
      const event = this.outboundIceQueue.shift();
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  getMediaInfo () {
    return {
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
      name: this._name,
      muted: this._muted,
      mediaTypes: this._mediaTypes,
    };
  }

  _handleError (error) {
    this._status = C.STATUS.STOPPED;
    return handleError(LOG_PREFIX, error);
  }
}
