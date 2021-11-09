/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const Balancer = require('../media/balancer');
const rid = require('readable-id');
const Logger = require('../utils/logger');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util');
const MEDIA_SPECS = C.DEFAULT_MEDIA_SPECS;
const MediaFactory = require('../media/media-factory');
const EventEmitter = require('events').EventEmitter;

const LOG_PREFIX = '[mcs-media]';
const MAX_EVENT_QUEUE_LENGTH = 20;

module.exports = class Media extends EventEmitter {
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
    super();
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
    this.profiles = options.profiles;

    this.status = C.STATUS.STARTED;

    // API event buffers for this media session
    this.eventBuffers = {};
    this.outboundIceQueue = [];
    this._mediaStateSubscription = false;
    this._iceSubscription = false;

    // Media specs for the media. If not specified, falls back to the default
    this.mediaSpecs = options.mediaSpecs? options.mediaSpecs : {...MEDIA_SPECS};

    // Media ID that serves as a subscription source tracker for a sink media
    this._subscribedTo = "";

    this.onHostOnline = this.onHostOnline.bind(this);
    this.onHostOffline= this.onHostOffline.bind(this);
  }

  set subscribedTo (mediaId) {
    // Empty string is a cleanup call (generally disconnects). We accept it as well.
    const media = mediaId? MediaFactory.getMedia(mediaId) : null;
    if (media || mediaId === '') {
      this._subscribedTo = mediaId;
      const eventInfo = media? media.getMediaInfo() : {};
      this.dispatchSubscribedTo(eventInfo);
    } else {
      Logger.warn(LOG_PREFIX, "Source media was not found on subscribedTo change", {
        subscriberId: this.id, sourceId: mediaId
      });
    }
  }

  get subscribedTo () {
    return this._subscribedTo;
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
  }

  stop () {
    if (this.status === C.STATUS.STARTED || this.status === C.STATUS.STARTING) {
      this.status = C.STATUS.STOPPING;
      try {
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
        Logger.info(LOG_PREFIX, "Session stopped", this.getMediaInfo());

        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_DISCONNECTED, this.getMediaInfo());
        // FIXME this is a workaround to also notify listeners hooked only to mediaSessionId
        // of a child media unit getting disconnected.
        const mediaInfo = this.getMediaInfo();
        mediaInfo.mediaId = this.mediaSessionId;
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_DISCONNECTED, mediaInfo);

        Balancer.removeListener(C.EVENT.MEDIA_SERVER_OFFLINE, this.onHostOffline);
        Balancer.removeListener(C.EVENT.MEDIA_SERVER_ONLINE, this.onHostOnline);

        this.emit(`${C.EVENT.MEDIA_DISCONNECTED}:${this.id}`, this.getMediaInfo());

        return this.adapter.stop(this.roomId, this.type, this.adapterElementId);
      }
      catch (err) {
        throw (this._handleError(err));
      }
    } else {
      return Promise.resolve();
    }
  }

  async connect (sink, type = 'ALL') {
    try {
      Logger.debug(LOG_PREFIX, "Connecting endpoints", {
        sourceId: this.id, sinkId: sink.id, type
      });
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
      const logObject = {
        sourceId: this.id,
        sourceAdapterElementId: this.adapterElementId,
        sinkId: sim.id,
        sinkAdapterElementId: sim.adapterElementId,
        connectionType,
      };

      Logger.debug(LOG_PREFIX, "Adapter elements to be connected", logObject);

      try {
        await this.adapter.connect(
          this.adapterElementId,
          sim.adapterElementId,
          connectionType,
        );

        // Update the sink's source data
        sim.subscribedTo = this.id;
      } catch (error) {
        Logger.error(LOG_PREFIX, `Failed to run underlying _connect procedure due to ${error.message}`,
          { ...logObject, error });
      }
    });
  }

  async disconnect (sink, type = 'ALL') {
    try {
      Logger.debug(LOG_PREFIX, "Disconnecting endpoints", {
        sourceId: this.id, sinkId: sink.id, type
      });
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
      Logger.debug(LOG_PREFIX, "Adapter elements to be disconnected", {
        sourceId: this.id,
        sourceAdapterElementId: this.adapterElementId,
        sinkId: sim.id,
        sinkAdapterElementId: sim.adapterElementId,
        connectionType,
      });

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

  addToEventBuffer (eventName, event) {
    if (this.eventBuffers[eventName] == null) {
      this.eventBuffers[eventName] = [];
    }

    if (this.eventBuffers[eventName].length >= MAX_EVENT_QUEUE_LENGTH) {
      this.eventBuffers[eventName].pop();
    }

    this.eventBuffers[eventName].push(event);
  }

  getBufferedEvents (eventName) {
    return this.eventBuffers[eventName];
  }

  _sendBufferedEvents (eventName) {
    const eventBuffer = this.eventBuffers[eventName];

    if (eventBuffer == null) {
      return;
    }

    eventBuffer.forEach(event => {
      GLOBAL_EVENT_EMITTER.emit(eventName, event);
    });
  }

  onEvent (eventName) {
    switch (eventName) {
      case C.EVENT.MEDIA_STATE.MEDIA_EVENT:
        if (this._mediaStateSubscription === false) {
          this._mediaStateSubscription = true;
          this._sendBufferedEvents(eventName);
        }
        break;
      case C.EVENT.MEDIA_STATE.ICE:
        if (this._iceSubscription === false) {
          this._iceSubscription = true;
          this._sendBufferedEvents(eventName);
        }
        break;
      default: Logger.trace(LOG_PREFIX, "Unknown event subscription", eventName);
    }
  }

  _dispatchMediaStateEvent (event) {
    // FIXME mediaId should be this.id
    const normEvent = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
    this.addToEventBuffer(C.EVENT.MEDIA_STATE.MEDIA_EVENT, normEvent);
    Logger.trace(LOG_PREFIX, `Dispatched ${C.EVENT.MEDIA_STATE.MEDIA_EVENT}`,
      { mediaSessionId: this.mediaSessionId, mediaId: this.id, event: normEvent });
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, normEvent);
  }

  _dispatchIceCandidate (event) {
    // FIXME mediaId should be this.id
    const normEvent = { mediaSessionId: this.mediaSessionId, mediaId: this.mediaSessionId, ...event };
    this.addToEventBuffer(C.EVENT.MEDIA_STATE.ICE, normEvent);
    Logger.trace(LOG_PREFIX, `Dispatched ${C.EVENT.MEDIA_STATE.ICE}`,
      { mediaSessionId: this.mediaSessionId, mediaId: this.id, event: normEvent });
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STATE.ICE, normEvent);
  }

  _dispatchStartTalkingEvent () {
    this.talking = true;
    const event = {
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
    }
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_START_TALKING, event);
  }

  _dispatchStopTalkingEvent () {
    this.talking = false;
    const event = {
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
    }
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_STOP_TALKING, event);
  }

  _dispatchVolumeChangedEvent (volume) {
    this.volume = volume;
    const event = {
      mediaId: this.id,
      volume: this.volume,
    }
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_VOLUME_CHANGED, event);
  }

  _dispatchMutedEvent () {
    this.muted = true;
    const event = {
      mediaId: this.id,
    }
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_MUTED, event);
  }

  _dispatchUnmutedEvent () {
    this.muted = false;
    const event = {
      mediaId: this.id,
    }
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_UNMUTED, event);
  }

  _dispatchConferenceNewVideoFloor () {
    const event = {
      mediaSessionId: this.mediaSessionId,
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
    }
    Logger.debug(LOG_PREFIX, "Dispatching conference new video floor event for ${this.id}",  { event });
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

  getMediaInfo () {
    return {
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
      mediaProfile: this.mediaProfile,
      adapterElementId: this.adapterElementId,
    };
  }

  setVolume (volume) {
    return this.adapter.setVolume(this.adapterElementId, volume);
  }

  mute () {
    return this.adapter.mute(this.adapterElementId);
  }

  unmute () {
    return this.adapter.unmute(this.adapterElementId);
  }

  dtmf (tone) {
    return this.adapter.dtmf(this.adapterElementId, tone);
  }

  requestKeyframe () {
    try {
      return this.adapter.requestKeyframe(this.adapterElementId);
    } catch (err) {
      // Media unit doesn't support keyf req. via its adapter. Fire a keyframeNeeded
      // event in hope the gateway who created it is listening to it and is
      // able to request it via signalling
      if (err.code === C.ERROR.MEDIA_INVALID_OPERATION.code) {
        this.keyframeNeeded();
        return Promise.resolve();
      }
    }
  }

  keyframeNeeded () {
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.KEYFRAME_NEEDED, this.id);
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
