/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const Balancer = require('../media/balancer');
const rid = require('readable-id');
const config = require('config');
const Logger = require('../utils/logger');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util');
const MEDIA_SPECS = config.get('conference-media-specs');
const StrategyManager = require('../media/strategy-manager.js');
const MediaFactory = require('../media/media-factory');

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
    this.memberType = C.MEMBERS.MEDIA;
    this.adapter = adapter;
    this.adapterElementId = adapterElementId;
    this.host = host;
    this.name = options.name;
    this.customIdentifier = options.customIdentifier;
    this.muted = false;
    this.volume = 50;
    this.talking = false;
    this.mediaTypes = {
      video: false,
      audio: false,
      text: false,
      content: false,
      application: false,
      message: false,
    }

    this.mediaProfile = options.mediaProfile;

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

    // Switching strategy
    this._strategy = options.strategy || C.STRATEGIES.FREEWILL;

    this.onHostOnline = this.onHostOnline.bind(this);
    this.onHostOffline= this.onHostOffline.bind(this);

    Logger.trace(LOG_PREFIX, "New", type, "media", this.getMediaInfo());
  }

  set subscribedTo (mediaId) {
    const media = MediaFactory.getMedia(mediaId);
    if (media) {
      this._subscribedTo = mediaId;
      this.dispatchSubscribedTo(media.getMediaInfo());
    } else {
      Logger.warn(LOG_PREFIX, `Source media was not found on subscribedTo change
        ${JSON.stringify({ subscriberId: this.id, sourceId: mediaId })}`);
    }
  }

  get subscribedTo () {
    return this._subscribedTo;
  }

  set strategy (strategy) {
    if (!StrategyManager.isValidStrategy(strategy)) {
      throw C.ERROR.MEDIA_INVALID_TYPE;
    }

    this._strategy = strategy;

    GLOBAL_EVENT_EMITTER.emit(C.EVENT.STRATEGY_CHANGED, this.getMediaInfo());
  }

  get strategy () {
    return this._strategy;
  }

  async trackMedia () {
    // Statically map adapter events to be listened to make it easier to maintain
    // All those events MUST be automagically untracked by the implementing adapter
    // when the adapter element is stopped, so we don't need to remove them here
    const ADAPTER_EVENTS_TO_LISTEN = [
      { eventType: C.EVENT.MEDIA_STATE.MEDIA_EVENT, callback: this._dispatchMediaStateEvent.bind(this) },
      { eventType: C.EVENT.MEDIA_STATE.ICE, callback: this._dispatchIceCandidate.bind(this) },
      { eventType: C.EVENT.MEDIA_START_TALKING, callback: this._dispatchStartTalkingEvent.bind(this) },
      { eventType: C.EVENT.MEDIA_STOP_TALKING, callback: this._dispatchStopTalkingEvent.bind(this) },
      { eventType: C.EVENT.MEDIA_VOLUME_CHANGED, callback: this._dispatchVolumeChangedEvent.bind(this) },
      { eventType: C.EVENT.MEDIA_MUTED, callback: this._dispatchMutedEvent.bind(this) },
      { eventType: C.EVENT.MEDIA_UNMUTED, callback: this._dispatchUnmutedEvent.bind(this) },
      { eventType: C.EVENT.CONFERENCE_FLOOR_CHANGED, callback: this._dispatchConferenceNewVideoFloor.bind(this) },
    ];

    ADAPTER_EVENTS_TO_LISTEN.forEach(({ eventType, callback }) => {
      const eventName = `${eventType}${this.adapterElementId}`
      this.adapter.on(eventName, callback);
    })

    this.adapter.trackMediaState(this.adapterElementId, this.type);

    Balancer.on(C.EVENT.MEDIA_SERVER_OFFLINE, this.onHostOffline);
    Balancer.on(C.EVENT.MEDIA_SERVER_ONLINE, this.onHostOnline);

    this.adapter.once(C.EVENT.MEDIA_DISCONNECTED+this.adapterElementId, this.stop.bind(this));

    Logger.info(LOG_PREFIX, "New media session", this.id, "in room", this.roomId, "started with media server endpoint", this.adapterElementId);
  }

  async stop () {
    if (this.status === C.STATUS.STARTED || this.status=== C.STATUS.STARTING) {
      this.status = C.STATUS.STOPPING;
      try {
        await this.adapter.stop(this.roomId, this.type, this.adapterElementId);

        if (this.mediaTypes.video) {
          Balancer.decrementHostStreams(this.host.id, C.MEDIA_PROFILE.MAIN);
        }

        if (this.mediaTypes.audio) {
          Balancer.decrementHostStreams(this.host.id, C.MEDIA_PROFILE.AUDIO);
        }

        if (this.mediaTypes.content) {
          Balancer.decrementHostStreams(this.host.id, C.MEDIA_PROFILE.CONTENT);
        }

        this.status = C.STATUS.STOPPED;
        Logger.info(LOG_PREFIX, "Session", this.id, "stopped with status", this.status);

        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_DISCONNECTED, this.getMediaInfo());

        Balancer.removeListener(C.EVENT.MEDIA_SERVER_OFFLINE, this.onHostOffline);
        Balancer.removeListener(C.EVENT.MEDIA_SERVER_ONLINE, this.onHostOnline);

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
      Logger.info(LOG_PREFIX, "Connecting endpoints", JSON.stringify({ sourceId: this.id, sinkId: sink.id, type}));
      await this._connect(sink, type);
    }
    catch (err) {
      throw (this._handleError(err));
    }
  }

  async _connect (sink, connectionType) {
    const sinks = sink.medias? sink.medias : [sink];
    let connSinks = [];

    switch (connectionType) {
      case C.CONNECTION_TYPE.AUDIO:
        connSinks = sinks.filter(sim => sim.mediaTypes.audio && sim.mediaTypes.audio !== 'sendonly');
        break;
      case C.CONNECTION_TYPE.VIDEO:
        connSinks = sinks.filter(sim => sim.mediaTypes.video && sim.mediaTypes.video !== 'sendonly');
        break;
      case C.CONNECTION_TYPE.CONTENT:
        connSinks = sinks.filter(sim => sim.mediaTypes.content && sim.mediaTypes.content !== 'sendonly');
        break;
      case C.CONNECTION_TYPE.ALL:
        connSinks = sinks;
        break;
      default:
        break;
    }


    connSinks.forEach(async sim => {
      Logger.info(LOG_PREFIX, "Adapter elements to be connected", JSON.stringify({
        sourceId: this.id,
        sourceAdapterElementId: this.adapterElementId,
        sinkId: sim.id,
        sinkAdapterElementId: sim.adapterElementId,
        connectionType,
      }));

      try {
        await this.adapter.connect(
          this.adapterElementId,
          sim.adapterElementId,
          connectionType,
        );

        // Update the sink's source data
        sim.subscribedTo = this.id;
      } catch (err) {
        throw (this._handleError(err));
      }
    });
  }

  async disconnect (sink, type = 'ALL') {
    try {
      Logger.info(LOG_PREFIX, "Disconnecting endpoints", JSON.stringify({ sourceId: this.id, sinkId: sink.id, type}));
      return this._disconnect(sink, type);
    }
    catch (err) {
      throw (this._handleError(err));
    }
  }

  async _disconnect (sink, connectionType) {
    const sinks = sink.medias? sink.medias : [sink];
    const sinkMediasToDisconnect = sinks.filter(sim => sim.subscribedTo === this.id);
    sinkMediasToDisconnect.forEach(async sim => {
      Logger.info(LOG_PREFIX, "Adapter elements to be disconnected", JSON.stringify({
        sourceId: this.id,
        sourceAdapterElementId: this.adapterElementId,
        sinkId: sim.id,
        sinkAdapterElementId: sim.adapterElementId,
        connectionType,
      }));

      try {
        await this.adapter.disconnect(
          this.adapterElementId,
          sim.adapterElementId,
          connectionType,
        );

        // Erase the sink's source data
        sim.subscribedTo = "";
      } catch (err) {
        throw (this._handleError(err));
      }
    });
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
      default: Logger.trace(LOG_PREFIX,"Unknown event subscription", eventName);
    }
  }

  _dispatchMediaStateEvent (event) {
    if (!this._mediaStateSubscription) {
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.debug(LOG_PREFIX,"Media", this.id, "queuing event", event);
      this.eventQueue.push(event);
    }
    else {
      // TODO mediaId could be this.id?
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.trace(LOG_PREFIX,"Dispatching media", this.id, "state event", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _dispatchIceCandidate (event) {
    if (!this._iceSubscription) {
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.debug(LOG_PREFIX,"Media ", this.id, "queuing event", event);
      this.outboundIceQueue.push(event);
    }
    else {
      // TODO mediaId should be this.id?
      event = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
      Logger.trace(LOG_PREFIX,"Dispatching ICE", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  _dispatchStartTalkingEvent () {
    this.talking = true;
    const event = {
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
    }
    Logger.debug(LOG_PREFIX,"Dispatching start talking", event);
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_START_TALKING, event);
  }

  _dispatchStopTalkingEvent () {
    this.talking = false;
    const event = {
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
    }
    Logger.debug(LOG_PREFIX,"Dispatching stop talking", event);
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STOP_TALKING, event);
  }

  _dispatchVolumeChangedEvent (volume) {
    this.volume = volume;
    const event = {
      mediaId: this.id,
      volume: this.volume,
    }
    Logger.info(LOG_PREFIX,"Dispatching volume changed", event);
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_VOLUME_CHANGED, event);
  }

  _dispatchMutedEvent () {
    this.muted = true;
    const event = {
      mediaId: this.id,
    }
    Logger.info(LOG_PREFIX,"Dispatching muted", event);
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_MUTED, event);
  }

  _dispatchUnmutedEvent () {
    this.muted = false;
    const event = {
      mediaId: this.id,
    }
    Logger.info(LOG_PREFIX,"Dispatching unmuted", event);
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_UNMUTED, event);
  }

  _dispatchConferenceNewVideoFloor () {
    const event = {
      mediaSessionId: this.mediaSessionId,
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
    }
    Logger.info(LOG_PREFIX,"Dispatching conference new video floor", event);
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_NEW_VIDEO_FLOOR, event);
  }

  dispatchSubscribedTo (sourceMediaInfo) {
    const event = {
      mediaId: this.id,
      sourceMediaInfo,
    }

    Logger.trace(LOG_PREFIX, "Dispatching subscribedTo event", event);
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.SUBSCRIBED_TO, event);
  }

  _flushMediaStateEvents () {
    Logger.debug(LOG_PREFIX,"Flushing media", this.id, "media state queue");

    while (this.eventQueue.length) {
      const event = this.eventQueue.shift();
      Logger.trace(LOG_PREFIX,"Dispatching queued media state event", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _flushIceEvents () {
    Logger.debug(LOG_PREFIX,"Flushing media", this.id, "ICE queue", this.outboundIceQueue);

    while (this.outboundIceQueue.length) {
      const event = this.outboundIceQueue.shift();
      Logger.trace(LOG_PREFIX,"Dispatching queue ICE", event);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  getMediaInfo () {
    const mediaInfo = {
      type: this.type,
      memberType: this.memberType,
      mediaSessionId: this.mediaSessionId,
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
      name: this.name,
      customIdentifier: this.customIdentifier || undefined,
      muted: this.muted,
      volume: this.volume,
      talking: this.talking,
      mediaTypes: this.mediaTypes,
      subscribedTo: this.subscribedTo,
      strategy: this.strategy,
      mediaProfile: this.mediaProfile,
      adapterElementId: this.adapterElementId,
    };
    return mediaInfo;
  }

  async setVolume(volume) {
    await this.adapter.setVolume(this.adapterElementId, volume);
  }

  async mute() {
    await this.adapter.mute(this.adapterElementId);
  }

  async unmute() {
    await this.adapter.unmute(this.adapterElementId);
  }

  dtmf (tone) {
    return this.adapter.dtmf(this.adapterElementId, tone);
  }

  setName(name) {
    this.name = name;
  }

  getContentMedia () {
    if (this.mediaTypes.content) {
      return this;
    }

    return null;
  }

  onHostOffline (hostId) {
    if (this.host && this.host.id === hostId) {
      const event = {
        state: { name: C.EVENT.MEDIA_SERVER_OFFLINE, details: 'offline' },
        mediaId: this.mediaSessionId
      }

      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);

      Balancer.removeListener(C.EVENT.MEDIA_SERVER_OFFLINE, this.onHostOffline);
    }
  }

  onHostOnline (hostId) {
    if (this.host && this.host.id === hostId) {
      Balancer.on(C.EVENT.MEDIA_SERVER_OFFLINE, this.onHostOffline);

      const event = {
        state: { name : C.EVENT.MEDIA_SERVER_ONLINE, details: 'online' },
        mediaId: this.mediaSessionId
      }

      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _handleError (error) {
    this._status = C.STATUS.STOPPED;
    return handleError(LOG_PREFIX, error);
  }
}
