/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const rid = require('readable-id');
const Kurento = require('../adapters/kurento/kurento');
const Freeswitch = require('../adapters/freeswitch/freeswitch');
const config = require('config');
const Logger = require('../utils/logger');
const AdapterFactory = require('../adapters/adapter-factory');
const { handleError } = require('../utils/util');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const MEDIA_SPECS = config.get('conference-media-specs');

const LOG_PREFIX = "[mcs-media-session]";

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
    room,
    user,
    type = 'WebRtcEndpoint',
    options = {}
  ) {
    this.id = rid();
    this.roomId = room;
    this.userId = user;
    this._options = options;
    // State indicator of this session. Might be STOPPED, STARTING or STARTED
    this._status = C.STATUS.STOPPED;
    // Signalling or transport layer type
    this._type = type;
    // Readable name for this session, provided by clients
    this.name = options.name? options.name : C.STRING.DEFAULT_NAME;
    // Media server adapter, falls back to Kurento
    this._adapter = options.adapter? options.adapter : C.STRING.KURENTO;
    // Custom string identifying a media session, up to clients to define it
    this._customIdentifier = options.customIdentifier? options.customIdentifier : null;
    // Media server interface based on given adapter
    this._isComposedAdapter = isComposedAdapter(this._adapter);
    this._adapters = AdapterFactory.getAdapters(this._adapter);
    // Media server adapter ID for this session's element
    this.videoMediaElement;
    this.audioMediaElement;
    // Array of media sessions that are subscribed to this feed
    this.subscribedSessions = [];
    this.medias = [];
    // An object that describes the capabilities of this media session
    this.mediaTypes = {
      video: false,
      audio: false,
      text: false,
      content: false,
      application: false,
      message: false,
    }
    // Nature of the media according to the use case (main || content || audio)
    this._mediaProfile = options.mediaProfile? options.mediaProfile : 'main';
    // Media specs for the media. If not specified, falls back to the default
    this.mediaSpecs = options.mediaSpecs? options.mediaSpecs : MEDIA_SPECS;
    this.muted = false;
    this.volume = 50;
  }

  async start () {
    this._status = C.STATUS.STARTING;
    return;
  }

  stop () {
    if (this._status === C.STATUS.STARTED || this._states === C.STATUS.STARTING) {
      this._status = C.STATUS.STOPPING;
      try {
        this.medias.forEach(async m => {
          await m.stop();
        });

        this._status = C.STATUS.STOPPED;

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
      // Connect this media session to sinks of the appropriate type
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
    const sourceMedia = sourceMediaId? sourceMediaId : this.medias.find(m => m._mediaProfile === mediaProfile);
    const sinkMedias = sink.medias? sink.medias.filter(m => (m._mediaProfile === mediaProfile || mediaProfile === C.MEDIA_PROFILE.ALL)) : [sink];
    if (sourceMedia && sinkMedias.length > 0) {
      sinkMedias.forEach(sinkMedia => {
        Logger.trace("[mcs-media-session] Adapter elements to be connected", sourceMedia.adapterElementId, "=>", sinkMedia.adapterElementId);
        try {
          sourceMedia.connect(
            sinkMedia,
            connectionType,
          );
        } catch (err) {
          // Temporarily supress connect error throw until we fix
          // the mediaProfile spec
          //throw (this._handleError(err));
          Logger.error(LOG_PREFIX, err);
        }
      });
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
    const sourceMedia = sourceMediaId? sourceMediaId : this.medias.find(m => m._mediaProfile === mediaProfile);
    const sinkMedias = sink.medias? sink.medias.filter(m => (m._mediaProfile === mediaProfile || mediaProfile === C.MEDIA_PROFILE.ALL)) : [sink];
    if (sourceMedia && sinkMedias.length > 0) {
      sinkMedias.forEach(sinkMedia => {
        Logger.trace(LOG_PREFIX, "Adapter elements to be disconnected", sourceMedia.adapterElementId, "=X>", sinkMedia.adapterElementId);
        try {
          return sourceMedia.disconnect(
            sinkMedia,
            connectionType,
          );
        } catch (err) {
          throw (this._handleError(err));
        }
      });
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

  async setVolume (volume) {
    try {
      this.medias.forEach(async m => {
        if (m.mediaTypes.audio) {
          m.setVolume(volume);
        }
      });
      if (volume === 0 && !this.muted) {
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
          };
          GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_UNMUTED, event);
          this.muted = false;
        }
      }
      return;
    } catch (err) {
      throw (this._handleError(err));
    }
  }

  dtmf (tone) {
    try {
      const media = this.medias.find(({ mediaTypes }) => mediaTypes.audio &&
        mediaTypes.audio !== 'sendonly');

      if (media == null) {
        throw (this._handleError({
          ...C.ERROR.MEDIA_NOT_FOUND,
          details: "MEDIA_SESSION_DTMF_NO_AVAILABLE_MEDIA_UNIT"
        }));
      }

      return media.dtmf(tone);
    } catch (e) {
      throw (this._handleError(e))
    }
  }

  sessionStarted () {
    if (this._status === C.STATUS.STARTING) {
      this._status = C.STATUS.STARTED;
      Logger.debug("[mcs-media-session] Session", this.id, "successfully started");
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
      mediaSessionId: this.id,
      mediaId: this.id,
      medias,
      roomId: this.roomId,
      userId: this.userId,
      name: this.name,
      customIdentifier: this._customIdentifier? this._customIdentifier : undefined,
      mediaTypes: this.mediaTypes,
      isMuted: this.muted,
      volume: this.volume,
    };

    return mediaInfo;
  }

  _handleError (error) {
    this._status = C.STATUS.STOPPED;
    return handleError(LOG_PREFIX, error);
  }

  createAndSetMediaNames () {
    this.medias.forEach(async (m, index) => {
      let name = `${this.name}-${++index}`
      Logger.debug(LOG_PREFIX,"Setting name", name, "for media", m.id);
      m.setName(name);
    });
  }

  getContentMedia () {
    let contentMedia = this.medias.find(m => m.mediaTypes.content && m.mediaTypes.content !== 'recvonly')

    if (contentMedia) {
      return contentMedia;
    }

    return this.medias.find(m => m.mediaTypes.video && m.mediaTypes.video !== 'recvonly');
  }
}
