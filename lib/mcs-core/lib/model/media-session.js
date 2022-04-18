/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const { v4: uuidv4 } = require('uuid');
const Logger = require('../utils/logger');
const AdapterFactory = require('../adapters/adapter-factory');
const { handleError } = require('../utils/util');
const GLOBAL_EVENT_EMITTER = require('../../../common/emitter.js');
const MEDIA_SPECS = C.DEFAULT_MEDIA_SPECS;

const LOG_PREFIX = "[mcs-media-session]";

const isComposedAdapter = adapter => {
  if (typeof adapter === 'object') {
    if (adapter.video && adapter.audio) {
      return true;
    }
  }

  return false;
}

const DEFAULT_PROFILES = {
  audio: 'sendrecv',
  video: 'sendrecv',
}

module.exports = class MediaSession {
  static meshConsume (sources, sinks, type) {
    return Promise.all(sinks.map(async (sim, i) => {
      const som = sources[i]? sources[i] : sources[0];
      if (som) {
        try {
          await sim.consume(
            som,
            type,
          );
        } catch (error) {
          throw handleError(LOG_PREFIX, error);
        }
      }
    }));
  }

  static meshConnect (sources, sinks, type) {
    sinks.forEach(async (sim, i) => {
      const som = sources[i]? sources[i] : sources[0];
      if (som) {
        try {
          Logger.debug("Media session: adapter elements to be connected", {
            sourceId: som.id,
            sourceAdapterElementId: som.adapterElementId,
            sinkId: sim.id,
            sinkAdapterElementId: sim.adapterElementId,
            type,
          });

          await som.connect(
            sim,
            type,
          );
        } catch (error) {
          throw handleError(LOG_PREFIX, error);
        }
      }
    });
  }

  static categorizeMediasByMediaType (medias, filterDirection) {
    const video = [];
    const audio = [];
    const content = [];

    if (medias) {
      medias.forEach(m => {
        if (m.mediaTypes.video && m.mediaTypes.video !== filterDirection) {
          video.push(m);
        }
        if (m.mediaTypes.audio && m.mediaTypes.audio !== filterDirection) {
          audio.push(m);
        }
        if (m.mediaTypes.content && m.mediaTypes.content !== filterDirection) {
          content.push(m);
        }
      });
    }

    return { video, audio, content };
  }

  constructor (
    room,
    user,
    type = 'WebRtcEndpoint',
    options = {}
  ) {
    this.id = uuidv4();
    this.roomId = room;
    this.userId = user;
    // There must always be a local "descriptor" (be it a SDP, an ORTC object,
    // an URI, ...)
    this._localDescriptor;
    // There must sometimes be a remote "descriptor" (be it a SDP, an ORTC object,
    // an URI, ...)
    this._remoteDescriptor;
    // The following attributes are optional parameters in the `options` object.
    // They'll be parsed and set in processOptionalParameters
    // Readable name for this session, provided by clients
    this.name;
    // Media server adapter, falls back to Kurento
    this._adapter;
    // Custom string identifying a media session, up to clients to define it
    this._customIdentifier;
    // Nature of the media according to the use case (video || content || audio)
    this._mediaProfile;
    // Media specs for the media. If not specified, falls back to the default
    this.mediaSpecs;
    // Profiles that this media should support. Used for the OFFERER role to be able
    // to set which media types and how many of them to set.
    this.profiles;
    this.processOptionalParameters(options);
    // State indicator of this session. Might be STOPPED, STARTING or STARTED
    this._status = C.STATUS.STOPPED;
    // Signalling or transport layer type
    this.type = type;
    // Defines if there are multiple adapters configured for this session
    this._isComposedAdapter = isComposedAdapter(this._adapter);
    // Media server interface based on given adapter
    this._adapters = AdapterFactory.getAdapters(this._adapter);
    // Media server adapter ID for this session's element
    this.videoMediaElement;
    this.audioMediaElement;
    // Array of media sessions that are subscribed to this feed
    this.subscribedSessions = [];
    this.medias = [];
    this.invalidMedias = [];
    // An object that describes the capabilities of this media session
    this.mediaTypes = {
      video: false,
      audio: false,
      text: false,
      content: false,
      application: false,
      message: false,
    }
    this.muted = false;
    this.volume = 50;
  }

  set muted (isMuted) {
    // Only mutate the muted state if it changed
    if (isMuted !== this._muted) {
      const event = {
        mediaId: this.id,
      }

      if (isMuted) {
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_MUTED, event);
      } else {
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_UNMUTED, event);
      }

      this._muted = isMuted;
    }
  }

  get muted () {
    return this._muted;
  }

  set volume (volume) {
    // Only mutate the volume state if it changed
    if (volume !== this._volume) {
      this._volume = volume;
      const event = {
        mediaId: this.id,
        volume,
      }
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_VOLUME_CHANGED, event);
      if (volume === 0) {
        if (!this.muted) {
          this.muted = true;
        }
      } else if (this.muted) {
        this.muted = false;
      }
    }
  }

  get volume () {
    return this._volume;
  }

  getAnswer () {
    //@PLACEHOLDER to be overridden by inheritors
    return this._localDescriptor;
  }

  start () {
    this._status = C.STATUS.STARTING;
  }

  stop () {
    if (this._status === C.STATUS.STARTED || this._status === C.STATUS.STARTING) {
      this._status = C.STATUS.STOPPING;
      try {
        this.medias.forEach(async m => {
          try {
            await m.stop();
          } catch (error) {
            Logger.error(`Media session: error when stopping media ${m.id}`,
              { error, ...m.getMediaInfo() });
          }
        });

        this._status = C.STATUS.STOPPED;
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_DISCONNECTED, this.getMediaInfo());
        return Promise.resolve();
      }
      catch (err) {
        throw (this._handleError(err));
      }
    } else {
      return Promise.resolve();
    }
  }

  async consume (source, type = 'ALL') {
    try {
      Logger.debug("Media session: consuming", {
        sourceId: this.id, sinkId: this.id, type
      });
      await this._consume(source, type);
      return this.getAnswer();
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  _consume (source, connectionType) {
    const sourceMedias = source.medias ? source.medias : [source]
    const {
      video: videoSources,
      audio: audioSources,
      content: contentSources,
    } = MediaSession.categorizeMediasByMediaType(sourceMedias, 'recvonly');
    const {
      video: videoSinks,
      audio: audioSinks,
      content: contentSinks,
    } = MediaSession.categorizeMediasByMediaType(this.medias, 'sendonly');

    switch (connectionType) {
      case C.CONNECTION_TYPE.AUDIO:
        return MediaSession.meshConsume(audioSources, audioSinks, C.CONNECTION_TYPE.AUDIO);
      case C.CONNECTION_TYPE.VIDEO:
        return MediaSession.meshConsume(videoSources, videoSinks, C.CONNECTION_TYPE.VIDEO);
      case C.CONNECTION_TYPE.CONTENT:
        return MediaSession.meshConsume(contentSources, contentSinks, C.CONNECTION_TYPE.CONTENT);
      case C.CONNECTION_TYPE.ALL:
        return Promise.all([
          MediaSession.meshConsume(videoSources, videoSinks, C.CONNECTION_TYPE.VIDEO),
          MediaSession.meshConsume(audioSources, audioSinks, C.CONNECTION_TYPE.AUDIO),
          MediaSession.meshConsume(contentSources, contentSinks, C.CONNECTION_TYPE.CONTENT),
        ]);
      default:
        throw { ...C.ERROR.MEDIA_INVALID_TYPE, details: `Invalid connection type ${connectionType}` };
    }
  }

  async connect (sink, type = 'ALL') {
    try {
      Logger.debug("Media session: connecting endpoints", { sourceId: this.id, sinkId: sink.id, type});
      return this._connect(sink, type);
    }
    catch (err) {
      throw (this._handleError(err));
    }
  }

  _connect (sink, connectionType) {
    const sinkMedias = sink.medias? sink.medias : [sink]
    const {
      video: videoSources,
      audio: audioSources,
      content: contentSources,
    } = MediaSession.categorizeMediasByMediaType(this.medias, 'recvonly');
    const {
      video: videoSinks,
      audio: audioSinks,
      content: contentSinks,
    } = MediaSession.categorizeMediasByMediaType(sinkMedias, 'sendonly');

    switch (connectionType) {
      case C.CONNECTION_TYPE.AUDIO:
        MediaSession.meshConnect(audioSources, audioSinks, C.CONNECTION_TYPE.AUDIO);
        break;
      case C.CONNECTION_TYPE.VIDEO:
        MediaSession.meshConnect(videoSources, videoSinks, C.CONNECTION_TYPE.VIDEO);
        break;
      case C.CONNECTION_TYPE.CONTENT:
        MediaSession.meshConnect(contentSources, contentSinks, C.CONNECTION_TYPE.CONTENT);
        break;
      case C.CONNECTION_TYPE.ALL:
        MediaSession.meshConnect(videoSources, videoSinks, C.CONNECTION_TYPE.VIDEO);
        MediaSession.meshConnect(audioSources, audioSinks, C.CONNECTION_TYPE.AUDIO);
        MediaSession.meshConnect(contentSources, contentSinks, C.CONNECTION_TYPE.CONTENT);
        break;
      default:
        throw { ...C.ERROR.MEDIA_INVALID_TYPE, details: `Invalid connection type ${connectionType}` };
    }
  }

  async disconnect (sink, type = 'ALL') {
    try {
      Logger.debug("Media session: disconnecting endpoints", { sourceId: this.id, sinkId: sink.id, type});
      return this._disconnect(sink, type);
    }
    catch (err) {
      throw (this._handleError(err));
    }
  }

  async _disconnect (sink, connectionType) {
    let sinkMedias = sink.medias? sink.medias : [sink]

    this.medias.forEach(som => {
      const sinkMediasToDisconnect = sinkMedias.filter(sim => sim.subscribedTo === som.id);
      sinkMediasToDisconnect.forEach(sim => {
        Logger.debug("Media session: adapter elements to be disconnected", {
          sourceId: som.id,
          sourceAdapterElementId: som.adapterElementId,
          sinkId: sim.id,
          sinkAdapterElementId: sim.adapterElementId,
          connectionType,
        });
        try {
          return som.disconnect(
            sim,
            connectionType,
          );
        } catch (err) {
          throw (this._handleError(err));
        }
      });
    });
  }

  setVolume (volume) {
    const prevVolume = this.volume;
    try {
      this.medias.forEach(async m => {
        if (m.mediaTypes.audio) {
          await m.setVolume(volume);
        }
      });
      this.volume = volume;
    } catch (err) {
      // Roll back just in case
      this.volume = prevVolume;
      throw (this._handleError(err));
    }
  }

  mute () {
    const prevMuteState = this.muted;
    try {
      this.medias.forEach(async m => {
        if (m.mediaTypes.audio && !m.muted) {
          await m.mute();
        }
      });
      this.muted = true;
    } catch (err) {
      // Roll back just in case
      this.muted = prevMuteState;
      throw (this._handleError(err));
    }
  }

  unmute () {
    const prevMuteState = this.muted;
    try {
      this.medias.forEach(async m => {
        if (m.mediaTypes.audio && m.muted) {
          await m.unmute();
        }
      });
      this.muted = false;
    } catch (err) {
      // Roll back just in case
      this.muted = prevMuteState;
      throw (this._handleError(err));
    }
  }

  dtmf (tone, options) {
    try {
      const media = this.medias.find(({ mediaTypes }) => mediaTypes.audio &&
        mediaTypes.audio !== 'sendonly');

      if (media == null) {
        throw (this._handleError({
          ...C.ERROR.MEDIA_NOT_FOUND,
          details: "MEDIA_SESSION_DTMF_NO_AVAILABLE_MEDIA_UNIT"
        }));
      }

      return media.dtmf(tone, options);
    } catch (e) {
      throw (this._handleError(e))
    }
  }

  requestKeyframe () {
    return new Promise((resolve, reject) => {
      try {
        const mediasToRequest= this.medias.filter(({ mediaTypes }) => mediaTypes.video &&
          mediaTypes.video !== 'recvonly');

        if (mediasToRequest.length <= 0) {
          throw (this._handleError({
            ...C.ERROR.MEDIA_NOT_FOUND,
            details: "MEDIA_SESSION_REQUEST_KEYFRAME_NO_AVAILABLE_MEDIA_UNIT"
          }));
        }

        mediasToRequest.forEach(async m => {
          try {
            await m.requestKeyframe();
          } catch (err) {
            // Media unit doesn't support keyf req. via its adapter. Fire a keyframeNeeded
            // event in hope the gateway who created it is listening to it and is
            // able to request it via signalling
            if (err.code === C.ERROR.MEDIA_INVALID_OPERATION.code) {
              m.keyframeNeeded();
            }
          }
        });

        return resolve();
      } catch (e) {
        return reject(this._handleError(e))
      }
    });
  }

  sessionStarted () {
    if (this._status === C.STATUS.STARTING) {
      this._status = C.STATUS.STARTED;
      Logger.debug(`Media session successfully started: ${this.id}`);
    }
  }

  onEvent (eventName, mediaId) {
    // Media specific event listener
    if (mediaId) {
      const media = this.medias.find(m => m.id === mediaId);
      if (media) {
        media.onEvent(eventName);
      }
      return;
    }

    // Session-wide event listener
    this.medias.forEach(m => {
      m.onEvent(eventName);
    });
  }

  getMediaInfo () {
    const medias = this.medias.map(m => m.getMediaInfo());
    const mediaInfo = {
      type: this.type,
      memberType: C.MEMBERS.MEDIA_SESSION,
      mediaSessionId: this.id,
      mediaId: this.id,
      medias,
      roomId: this.roomId,
      userId: this.userId,
      name: this.name,
      customIdentifier: this._customIdentifier || undefined,
      mediaTypes: this.mediaTypes,
      isMuted: this.muted,
      volume: this.volume,
      mediaProfile: this._mediaProfile,
    };

    return mediaInfo;
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }

  createAndSetMediaNames () {
    this.medias.forEach((m, index) => {
      const name = `${this.name}-${++index}`
      m.setName(name);
    });
  }

  getContentMedia () {
    const contentMedia = this.medias.find(m => m.mediaTypes.content && m.mediaTypes.content !== 'recvonly');

    if (contentMedia) {
      return contentMedia;
    }

    return this.medias.find(m => m.mediaTypes.video && m.mediaTypes.video !== 'recvonly');
  }

  processOptionalParameters (options) {
    this._options = options;
    // Readable name for this session, provided by clients
    this.name = options.name? options.name : C.STRING.DEFAULT_NAME;
    // Media server adapter, falls back to Kurento
    this._adapter = options.adapter? options.adapter : C.STRING.KURENTO;
    // Custom string identifying a media session, up to clients to define it
    this._customIdentifier = options.customIdentifier? options.customIdentifier : null;
    // Nature of the media according to the use case (video || content || audio)
    this._mediaProfile = options.mediaProfile;
    // Media specs for the media. If not specified, falls back to the default
    this.mediaSpecs = options.mediaSpecs? options.mediaSpecs : {...MEDIA_SPECS};
    // API-specified media profiles (audio|video|content: 'string'|boolean =>
    // 'recvonly'|'sendonly'|'sendrecv'|true|false
    this.profiles = options.profiles || DEFAULT_PROFILES;
    // Whether this media session should be ignored by the media limiter
    this.ignoreThresholds = options.ignoreThresholds || false;
  }
}
