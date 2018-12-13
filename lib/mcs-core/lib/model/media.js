/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const SdpWrapper = require('../utils/sdp-wrapper');
const Balancer = require('../media/balancer');
const rid = require('readable-id');
const config = require('config');
const Logger = require('../utils/logger');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const MEDIA_SPECS = config.get('conference-media-specs');
const { handleError } = require('../utils/util');
const LOG_PREFIX = '[mcs-media]';

module.exports = class Media {
  constructor(
    roomId,
    userId,
    mediaSessionId,
    type,
    adapter,
    adapterElementId,
    host,
    options = {}
  ) {
    // {SdpWrapper} SdpWrapper
    this.id = rid();
    this.roomId = roomId;
    this.userId = userId;
    this.mediaSessionId = mediaSessionId;
    this.type = type;
    this.adapter = adapter;
    this.adapterElementId = adapterElementId;
    this.host = host;
    this.name = options.name;
    this.customIdentifier = options.customIdentifier;
    this.muted = false;
    this.mediaTypes = {};
    this.status = C.STATUS.STARTED;

    // API event buffers for this media session
    this.eventQueue = [];
    this.outboundIceQueue = [];
    this._mediaStateSubscription = false;
    this._iceSubscription = false;

    Logger.trace(LOG_PREFIX, "New", type, "media", this.getMediaInfo());
  }

  async trackMedia () {
    this.adapter.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT+this.adapterElementId, this._dispatchMediaStateEvent.bind(this));
    this.adapter.on(C.EVENT.MEDIA_STATE.ICE+this.adapterElementId, this._dispatchIceCandidate.bind(this));

    this.adapter.trackMediaState(this.adapterElementId, this.type);

    const notifyHostOffline = (hostId) => {
      if (this.host && this.host.id === hostId) {
        let event = {};
        event.state = { name: C.EVENT.MEDIA_SERVER_OFFLINE, details: 'offline' };
        event.mediaId = this.id;
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);

        this.balancer.removeListener(C.EVENT.MEDIA_SERVER_OFFLINE, notifyHostOffline);
      }
    };

    const notifyHostOnline = (hostId) => {
      if (this.host && this.host.id === hostId) {
        let event = {};
        event.state = { name : C.EVENT.MEDIA_SERVER_ONLINE, details: 'online' };
        event.mediaId = this.id;
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
      }
    };

    Balancer.on(C.EVENT.MEDIA_SERVER_OFFLINE, notifyHostOffline);
    Balancer.on(C.EVENT.MEDIA_SERVER_ONLINE, notifyHostOnline);

    Balancer.on(C.EVENT.MEDIA_SERVER_ONLINE, () => {
      let event = {};
      event.state = C.EVENT.MEDIA_SERVER_ONLINE;
      event.mediaId = this.id;
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.SERVER_STATE, event);
    });

    this.adapter.once(C.EVENT.MEDIA_DISCONNECTED+this.adapterElementId, this.stop.bind(this));


    Logger.info(LOG_PREFIX, "New media session", this.id, "in room", this.roomId, "started with media server endpoint", this.adapterElementId);
  }

  async stop () {
    if (this.status === C.STATUS.STARTED || this.status=== C.STATUS.STARTING) {
      this.status = C.STATUS.STOPPING;
      try {
        await this.adapter.stop(this.roomId, this.type, this.adapterElementId);

        if (this.hasVideo) {
          Balancer.decrementHostStreams(this.host.id, 'video');
        }

        this.status = C.STATUS.STOPPED;
        Logger.info(LOG_PREFIX, "Session", this.id, "stopped with status", this.status);
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_DISCONNECTED, { roomId: this.roomId, mediaId: this.id, mediaSessionId: this.mediaSessionId });

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
    if (!this._mediaStateSubscription) {
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", { mediaId: this.id, ...event });
      this.eventQueue.push(event);
    }
    else {
      // TODO mediaId could be this.id?
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.trace("[mcs-media-session] Dispatching", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _dispatchIceCandidate (event) {
    if (!this._iceSubscription) {
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", event);
      this.outboundIceQueue.push({ mediaId: this.id, ...event});
    }
    else {
      // TODO mediaId should be this.id?
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.trace("[mcs-media-session] Dispatching ICE", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  _flushMediaStateEvents () {
    Logger.debug("[mcs-media-session] Flushing session", this.id, "media state queue");

    while (this.eventQueue.length) {
      const event = this.eventQueue.shift();
      Logger.trace("[mcs-media-session] Dispatching queued media state event", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _flushIceEvents () {
    Logger.debug("[mcs-media-session] Flushing session", this.id, "ICE queue", this.outboundIceQueue);

    while (this.outboundIceQueue.length) {
      const event = this.outboundIceQueue.shift();
      Logger.trace("[mcs-media-session] Dispatching queue ICE", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  getMediaInfo () {
    const mediaInfo = {
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
      name: this.name,
      customIdentifier: this.customIdentifier? this.customIdentifier : undefined,
      muted: this.muted,
      mediaTypes: this.mediaTypes,
    };
    return mediaInfo;
  }

  _handleError (error) {
    this._status = C.STATUS.STOPPED;
    return handleError(LOG_PREFIX, error);
  }
}
