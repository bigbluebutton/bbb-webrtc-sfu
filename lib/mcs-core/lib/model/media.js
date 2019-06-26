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
const { handleError } = require('../utils/util');
const MEDIA_SPECS = config.get('conference-media-specs');
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
    this.volume = 50;
    this.mediaTypes = {
      video: false,
      audio: false,
      text: false,
      content: false,
      application: false,
      message: false,
    }

    this.mediaProfile = options.mediaProfile? options.mediaProfile : 'main';
    this.status = C.STATUS.STARTED;

    // API event buffers for this media session
    this.eventQueue = [];
    this.outboundIceQueue = [];
    this._mediaStateSubscription = false;
    this._iceSubscription = false;

    // Media specs for the media. If not specified, falls back to the default
    this.mediaSpecs = options.mediaSpecs? options.mediaSpecs : MEDIA_SPECS;

    // Media ID that serves as a subscription source tracker for a sink media
    this._subscribedTo = "";

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
        event.mediaId = this.mediaSessionId;
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);

        Balancer.removeListener(C.EVENT.MEDIA_SERVER_OFFLINE, notifyHostOffline);
      }
    };

    const notifyHostOnline = (hostId) => {
      if (this.host && this.host.id === hostId) {
        let event = {};
        event.state = { name : C.EVENT.MEDIA_SERVER_ONLINE, details: 'online' };
        event.mediaId = this.mediaSessionId;
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

        if (this.hasAudio) {
          Balancer.decrementHostStreams(this.host.id, 'audio');
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

  async connect (sink, type = 'ALL') {
    try {
      // Connect this media unit to sinks of the appropriate type
      // TODO REVIEW THE CONTENT X VIDEO CONNECTION_TYPE ASAP (it makes little sense)
      switch (type ) {
        case C.CONNECTION_TYPE.AUDIO:
          await this._connectAudio(sink);
          break;
        case C.CONNECTION_TYPE.VIDEO:
          await this._connectVideo(sink);
          break;
        case C.CONNECTION_TYPE.CONTENT:
          await this._connectContent(sink);
          break;
        default:
          await this._connectEverything(sink);
      }
      return;
    }
    catch (err) {
      throw (this._handleError(err));
    }
  }

  async _connect (sink, sourceMediaId, mediaProfile, connectionType) {
    const connSink = sink.medias? sink.medias[0] : sink;

    Logger.trace(LOG_PREFIX, "Adapter elements to be connected", this.adapterElementId, "=>", connSink.adapterElementId);
    try {
      await this.adapter.connect(
        this.adapterElementId,
        connSink.adapterElementId,
        connectionType,
      );

      // Update the sink's source data
      connSink.subscribedTo = this.id;
    } catch (err) {
      // Temporarily supress connect error throw until we fix
      // the mediaProfile spec
      //throw (this._handleError(err));
      this._handleError(err);
    }
  }

  _connectContent (sink, sourceMediaId = null) {
    return this._connect(sink, sourceMediaId, C.MEDIA_PROFILE.CONTENT, C.CONNECTION_TYPE.VIDEO);
  }

  _connectAudio (sink, sourceMediaId = null) {
    return this._connect(sink, sourceMediaId, C.MEDIA_PROFILE.AUDIO, C.CONNECTION_TYPE.AUDIO);
  }

  _connectVideo (sink, sourceMediaId = null) {
    return this._connect(sink, sourceMediaId, C.MEDIA_PROFILE.VIDEO, C.CONNECTION_TYPE.VIDEO);
  }

  _connectEverything (sink, sourceMediaId = null) {
    return this._connect(sink, sourceMediaId, C.MEDIA_PROFILE.ALL, C.CONNECTION_TYPE.ALL);
  }

  async disconnect (sink, type = 'ALL') {
    try {
      // Disconnect this media session to sinks of the appropriate type
      // in the future, it'd also be nice to be able to connect children media of a session
      switch (type ) {
        case C.CONNECTION_TYPE.CONTENT:
          await this._disconnectContent(sink);
          break;
        case C.CONNECTION_TYPE.AUDIO:
          await this._disconnectAudio(sink);
          break;
        case C.CONNECTION_TYPE.VIDEO:
          await this._disconnectVideo(sink);
          break;
        default:
          await this._disconnectEverything(sink);
      }
      return;
    }
    catch (err) {
      throw (this._handleError(err));
    }
  }

  async _disconnect (sink, sourceMediaId, mediaProfile, connectionType) {
    const connSink = sink.medias? sink.medias[0] : sink;
    Logger.trace(LOG_PREFIX, "Adapter elements to be disconnected", this.adapterElementId, "=X>", connSink.adapterElementId);

    try {
      return this.adapter.disconnect(
        this.adapterElementId,
        connSink.adapterElementId,
        connectionType,
      );

      // Erase the sink's source data
      connSink.subscribedTo = "";
    } catch (err) {
      throw (this._handleError(err));
    }
  }

  _disconnectContent (sink, sourceMediaId = null) {
    return this._disconnect(sink, sourceMediaId, C.MEDIA_PROFILE.CONTENT, C.CONNECTION_TYPE.VIDEO);
  }

  _disconnectAudio (sink, sourceMediaId = null) {
    return this._disconnect(sink, sourceMediaId, C.MEDIA_PROFILE.AUDIO, C.CONNECTION_TYPE.AUDIO);
  }

  _disconnectVideo (sink, sourceMediaId = null) {
    return this._disconnect(sink, sourceMediaId, C.MEDIA_PROFILE.VIDEO, C.CONNECTION_TYPE.VIDEO);
  }

  _disconnectEverything (sink, sourceMediaId = null) {
    return this._disconnect(sink, sourceMediaId, C.MEDIA_PROFILE.ALL, C.CONNECTION_TYPE.ALL);
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
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", event);
      this.eventQueue.push(event);
    }
    else {
      // TODO mediaId could be this.id?
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.info("[mcs-media-session] Media", this.id, "media state event", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _dispatchIceCandidate (event) {
    if (!this._iceSubscription) {
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", event);
      this.outboundIceQueue.push(event);
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
      mediaSessionId: this.mediaSessionId,
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
      name: this.name,
      customIdentifier: this.customIdentifier? this.customIdentifier : undefined,
      muted: this.muted,
      volume: this.volume,
      mediaTypes: this.mediaTypes,
      subscribedTo: this.subscribedTo,
    };
    return mediaInfo;
  }

  async setVolume(volume) {
    await this.adapter.setVolume(this.adapterElementId, volume);
    if (volume === 0 && !this.muted) {
      // only mute (save the previous volume to restore after unmute)
      const event = {
        mediaId: this.id,
      }
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_MUTED, event);
      this.muted = true;
    }
    else {
      this.volume = volume;
      const event = {
        mediaId: this.id,
        volume: this.volume,
      }
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_VOLUME_CHANGED, event);
      if (this.muted) {
        const event = {
          mediaId: this.id,
        }
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_UNMUTED, event);
        this.muted = false;
      }
    }
  }

  dtmf (tone) {
    return this.adapter.dtmf(this.adapterElementId, tone);
  }

  setName(name) {
    this.name = name;
  }

  set subscribedTo (mediaId) {
    this._subscribedTo = mediaId;
  }

  get subscribedTo () {
    return this._subscribedTo;
  }

  getContentMedia () {
    return this;
  }

  _handleError (error) {
    this._status = C.STATUS.STOPPED;
    return handleError(LOG_PREFIX, error);
  }
}
