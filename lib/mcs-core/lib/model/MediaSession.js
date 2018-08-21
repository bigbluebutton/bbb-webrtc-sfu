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
const Logger = require('../../../utils/Logger');
const { handleError } = require('../utils/util');
const LOG_PREFIX = "[mcs-media-session]";
const Balancer = require('../media/balancer');
Balancer.upstartHosts();

const isComposedAdapter = adapter => {
  if (typeof adapter === 'object') {
    if (adapter.video && adapter.audio) {
      return true;
    }
  }

  return false;
}

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
    this.balancer = Balancer;
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
    // Custom string identifying a media session, up to clients to define it
    this._customIdentifier = options.customIdentifier? options.customIdentifier : null;
    // Media server interface based on given adapter
    this._isComposedAdapter = isComposedAdapter(this._adapter);
    if (this._isComposedAdapter) {
      this._audioAdapter = MediaSession.getAdapter(this._adapter.audio);
      this._videoAdapter = MediaSession.getAdapter(this._adapter.video);
    } else {
      this._audioAdapter = MediaSession.getAdapter(this._adapter);
      this._videoAdapter = MediaSession.getAdapter(this._adapter);
    }
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
      case C.STRING.FREESWITCH:
        obj = new Freeswitch(Balancer);
        break;
      default:
        obj = new Kurento(Balancer);
        break;
    }

    return obj;
  }


  async start () {
    this._status = C.STATUS.STARTING;
    try {
      let mediaElement, host;
      await this._videoAdapter.init();
      await this._audioAdapter.init();

      if (this._isComposedAdapter) {
        ({ mediaElement, host } = await this._videoAdapter.createMediaElement(this.roomId, this._type, this._options));

        this.videoMediaElement = mediaElement;
        this.videoHost = host;

        ({ mediaElement, host } = await this._audioAdapter.createMediaElement(this.roomId, this._type, this._options));

        this.audioMediaElement = mediaElement;
        this.audioHost = host;

        this._upstartMediaElement(this._videoAdapter, this.videoMediaElement);
        this._upstartMediaElement(this._audioAdapter, this.audioMediaElement);
      } else {
        ({ mediaElement, host } = await this._videoAdapter.createMediaElement(this.roomId, this._type, this._options));

        this.videoMediaElement = mediaElement;
        this.videoHost = host;

        this._upstartMediaElement(this._videoAdapter, this.videoMediaElement);
      }

      return;
    }
    catch (err) {
      err = this._handleError(err);
      throw err;
    }
  }

  async _upstartMediaElement (adapter, element) {
    adapter.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT+element, this._dispatchMediaStateEvent.bind(this));
    adapter.on(C.EVENT.MEDIA_STATE.ICE+element, this._dispatchIceCandidate.bind(this));

    adapter.trackMediaState(element, this._type);

    adapter.on(C.ERROR.MEDIA_SERVER_OFFLINE, () => {
      let event = {};
      event.state = C.ERROR.MEDIA_SERVER_OFFLINE;
      event.mediaId = this.id;
      this.emitter.emit(C.EVENT.SERVER_STATE, event);
    });

    adapter.on(C.EVENT.MEDIA_SERVER_ONLINE, () => {
      let event = {};
      event.state = C.EVENT.MEDIA_SERVER_ONLINE;
      event.mediaId = this.id;
      this.emitter.emit(C.EVENT.SERVER_STATE, event);
    });

    Logger.info("[mcs-media-session] New media session", this.id, "in room", this.roomId, "started with media server endpoint", element);
  }

  async stop () {
    if (this._status === C.STATUS.STARTED) {
      this._status = C.STATUS.STOPPING;
      try {
        await this._videoAdapter.stop(this.roomId, this._type, this.videoMediaElement);

        if (this._isComposedAdapter) {
          await this._audioAdapter.stop(this.roomId, this._type, this.audioMediaElement);
        }

        this._status = C.STATUS.STOPPED;
        Logger.info("[mcs-media-session] Session", this.id, "stopped with status", this._status);
        this.emitter.emit(C.EVENT.MEDIA_DISCONNECTED, { roomId: this.roomId, mediaId: this.id });

        if (this.hasVideo) {
          if (this._isComposedAdapter && this._adapter.video === C.STRING.KURENTO ||
            this._adapter === C.STRING.KURENTO) {
            this.balancer.decrementHostStreams(this.videoHost.id, 'video');
          }
        }

        if (this.hasAudio) {
          if (this._isComposedAdapter && this._adapter.audio === C.STRING.KURENTO) {
            this.balancer.decrementHostStreams(this.audioHost.id, 'audio');
          } else {
            this.balancer.decrementHostStreams(this.videoHost.id, 'audio');
          }
        }

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
      let adapter, sourceElement, sinkElement;
      Logger.info("[mcs-media-session] Connecting ", this.id, "=>", sink.id);
      if (type === 'AUDIO') {
        adapter = this._audioAdapter;
        sourceElement = this.audioMediaElement;
        sinkElement = sink.audioMediaElement;
      } else {
        adapter = this._videoAdapter;
        sourceElement = this.videoMediaElement;
        sinkElement = sink.videoMediaElement;
      }

      Logger.debug("[mcs-media-session] Adapter elements to be connected", sourceElement, "=>", sinkElement);
      await adapter.connect(sourceElement, sinkElement, type);
      return;
    }
    catch (err) {
      err = this._handleError(err);
      throw err;
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

    if (!this._mediaStateSubscription) {
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", { mediaId: this.id, ...event });
      this.eventQueue.push(event);
    }
    else {
      Logger.trace("[mcs-media-session] Dispatching", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, { mediaId: this.id, ...event });
    }
  }

  _dispatchIceCandidate (event) {
    if (!this._iceSubscription) {
      Logger.debug("[mcs-media-session] Media session", this.id, "queuing event", event);
      this.outboundIceQueue.push({ mediaId: this.id, ...event});
    }
    else {
      Logger.trace("[mcs-media-session] Dispatching ICE", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.ICE, { mediaId: this.id, ...event });
    }
  }

  _flushMediaStateEvents () {
    Logger.debug("[mcs-media-session] Flushing session", this.id, "media state queue");

    while (this.eventQueue.length) {
      const event = this.eventQueue.shift();
      Logger.trace("[mcs-media-session] Dispatching queued media state event", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event);
    }
  }

  _flushIceEvents () {
    Logger.debug("[mcs-media-session] Flushing session", this.id, "ICE queue", this.outboundIceQueue);

    while (this.outboundIceQueue.length) {
      const event = this.outboundIceQueue.shift();
      Logger.trace("[mcs-media-session] Dispatching queue ICE", event);
      this.emitter.emit(C.EVENT.MEDIA_STATE.ICE, event);
    }
  }

  getMediaInfo () {
    const mediaInfo = {
      mediaId: this.id,
      roomId: this.roomId,
      userId: this.userId,
      name: this._name,
      customIdentifier: this._customIdentifier? this._customIdentifier : undefined,
      muted: this._muted,
      mediaTypes: this._mediaTypes,
    };
    return mediaInfo;
  }

  _handleError (error) {
    this._status = C.STATUS.STOPPED;
    return handleError(LOG_PREFIX, error);
  }
}
