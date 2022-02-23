/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const MediaSession = require('./media-session');
const InternalUnsupportedMedia = require('./int-unsupported-media.js');
const Logger = require('../utils/logger');
const GLOBAL_EVENT_EMITTER = require('../../../common/emitter.js');
const LOG_PREFIX = "[mcs-ortc-session]";

module.exports = class ORTCSession extends MediaSession {
  static filterProfilesByMType (targetMediaType, profiles = {}) {
    const filteredProfiles = {};
    for (const [mediaType, mediaTypeDir] of Object.entries(profiles)) {
      if (targetMediaType === mediaType) filteredProfiles[mediaType] = mediaTypeDir;
    }

    return filteredProfiles;
  }

  constructor(
    remoteDescriptor = null,
    room,
    user,
    type = 'WebRtcEndpoint',
    options
  ) {
    super(room, user, type, options);
    this._remoteDescriptor;
    this._localDescriptor;

    this.negotiationRole = '';
    this.shouldRenegotiate = false;
    this.shouldProcessRemoteDescriptorAsAnswerer = false;

    if (remoteDescriptor) {
      this.remoteDescriptor = remoteDescriptor;
    }

    Logger.info(LOG_PREFIX,  "New session created", JSON.stringify(this.getMediaInfo()));
  }

  set remoteDescriptor (remoteDescriptor) {
    if (remoteDescriptor) {
      if (this.localDescriptor == null && !this.negotiationRole) {
        this.negotiationRole = C.NEGOTIATION_ROLE.ANSWERER;
      }

      if (this._remoteDescriptor) {
        this.shouldRenegotiate = true;
      } else if (this.negotiationRole === C.NEGOTIATION_ROLE.OFFERER) {
        this.shouldProcessRemoteDescriptorAsAnswerer = true;
      }

      this._remoteDescriptor = remoteDescriptor;

      if (this.negotiationRole === C.NEGOTIATION_ROLE.OFFERER) {
        // TODO enforce spec
      }
    }
  }

  set shouldProcessRemoteDescriptorAsAnswerer (shouldProcess) {
    if (shouldProcess === true && !this.shouldProcessRemoteDescriptorAsAnswerer) {
      GLOBAL_EVENT_EMITTER.emit(`${C.EVENT.MEDIA_NEGOTIATED}:${this.id}`,
        this.getMediaInfo());
    }

    this._shouldProcessRemoteDescriptorAsAnswerer = shouldProcess;
  }

  get shouldProcessRemoteDescriptorAsAnswerer () {
    return this._shouldProcessRemoteDescriptorAsAnswerer;
  }

  get remoteDescriptor () {
    return this._remoteDescriptor;
  }

  set localDescriptor (localDescriptor) {
    if (localDescriptor) {
      this._localDescriptor = localDescriptor;

      if (this.remoteDescriptor == null && !this.negotiationRole) {
        this.negotiationRole = C.NEGOTIATION_ROLE.OFFERER;
      }

      if (this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER) {
        // TODO enforce spec
      }
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  async _rejectMedias (descriptor = '') {
    if (!descriptor) {
      return [];
    }
    const unsupportedMediaContainer = new InternalUnsupportedMedia(
      this.roomId,
      this.userId,
      this.id,
      descriptor,
      C.MEDIA_TYPE.INTERNAL_UNSUPPORTED,
    );
    return [unsupportedMediaContainer];
  }

  _monoAdapterProcess () {
    // The adapter is the same for all media types, so either one will suffice
    return this._adapters.videoAdapter.negotiate(this.roomId, this.userId, this.id, this.remoteDescriptor, this.type, this._options).then(medias => {
      medias.forEach((m, index) => {
        m.ortcIndex = index;
      });
      this.medias = this.medias.concat(medias);
    }).catch(error => {
      throw error;
    });
  }

  async renegotiateStreams () {
    try {
      const {
        videoAdapter,
      } = this._adapters;

      // Short exit: we have a single media. Probably a proper single m=* line
      // session or a multi m=* line where the adapter does it stuff right
      const tMedia = this.medias[0];
      try {
        if (tMedia) {
          Logger.trace(LOG_PREFIX, 'Processing unified answerer streams', {
            mediaSessionId: this.id,
            mediaId: tMedia.id,
            descriptor: this.remoteDescriptor,
          });

          await videoAdapter.processAnswer(
            tMedia.adapterElementId,
            this.remoteDescriptor,
            { mediaTypes: tMedia.mediaTypes, ...this._options }
          );

          tMedia.remoteDescriptor = this.remoteDescriptor;
        } else {
          throw ({
            ...C.ERROR.MEDIA_NOT_FOUND,
            details: 'No unified media on renegotiation',
          });
        }

        this.localDescriptor = this.getAnswer();
        return this.localDescriptor;
      } catch (error) {
        Logger.error(LOG_PREFIX, 'Renegotiation failed',
          { roomId: this.roomId, userId: this.userId, mediaSessionId: this.id, error }
        );
        throw error;
      }
    } catch (error) {
      throw this._handleError(error);
    }
  }

  _hasValidMedias () {
    // Checks if the media server was able to find a compatible media line
    if (this.medias.length <= 0 && this.remoteDescriptor) {
      return false;
    }

    if (this.remoteDescriptor && this.localDescriptor) {
      if (!this._hasAvailableCodec()) {
        return false;
      }
    }

    return true;
  }

  async process () {
    let localDescriptorAnswer;

    // If this is marked for renegotiation, do it
    if (this.shouldRenegotiate || this.shouldProcessRemoteDescriptorAsAnswerer) {
      try {
        localDescriptorAnswer = await this.renegotiateStreams();
        if (this.shouldProcessRemoteDescriptorAsAnswerer) {
          this.shouldProcessRemoteDescriptorAsAnswerer = false;
        }
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_RENEGOTIATED, this.getMediaInfo());
        return localDescriptorAnswer;
      } catch (e) {
        throw (this._handleError(e));
      }
    }

    try {
      // No adapter composition in this one.
      this._monoAdapterProcess();
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Failed to process ORTC session', {
        roomId: this.roomId,
        userId: this.userId,
        mediaSessionId: this.id,
        errorMessage: error.message,
        errorCode: error.code,
      });
      throw (this._handleError(error));
    }

    this.localDescriptor = this.getAnswer();

    localDescriptorAnswer = this.localDescriptor || null;

    if (!this._hasValidMedias()) {
      throw (this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
    }

    this.fillMediaTypes();
    this.createAndSetMediaNames();

    // We only emit the MEDIA_NEGOTIATED event when the negotiation has been
    // sucessfully enacted. In the case where we are the answerer, we fire it here.
    // If we are the offerer, we fire it when the answer is properly
    // processed and the shouldProcessRemoteDescriptorAsAnswerer flag is
    // deactivated (see shouldProcessRemoteDescriptorAsAnswerer setter)
    if (this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER) {
      GLOBAL_EVENT_EMITTER.emit(`${C.EVENT.MEDIA_NEGOTIATED}:${this.id}`,
        this.getMediaInfo());
    }

    Logger.trace(LOG_PREFIX, `Answer for session ${this.id}`, { localDescriptorAnswer });
    return localDescriptorAnswer;
  }

  fillMediaTypes () {
    this.mediaTypes.video = this.medias.some(m => m.mediaTypes.video);
    this.mediaTypes.content = this.medias.some(m => m.mediaTypes.content) || this._mediaProfile === C.MEDIA_PROFILE.CONTENT;
    this.mediaTypes.audio = this.medias.some(m => m.mediaTypes.audio);
  }

  addIceCandidate (candidate) {
    const _add = (targetMedia, candidate) => {
      if (targetMedia.type === C.MEDIA_TYPE.WEBRTC) {
        return targetMedia.addIceCandidate(candidate).catch(error => {
          Logger.warn(LOG_PREFIX, `Failed to add ICE candidate`, {
            mediaSessionId: this.id,
            mediaId: targetMedia.id,
            candidate,
            error: this._handleError(error)
          });

          throw error;
        });
      }
    };

    if (this.medias.length === 1) {
      return _add(this.medias[0], candidate);
    }

    // TODO check #mid or #rid against media units.
    const { sdpMLineIndex, sdpMid } = candidate;
    if (sdpMLineIndex && this.medias[sdpMLineIndex]) {
      return _add(this.medias[sdpMLineIndex], candidate);
    } else if (sdpMid && this.medias[sdpMid]) {
      return _add(this.medias[sdpMid], candidate);
    } else {
      throw this._handleError({
        ...C.ERROR.ICE_CANDIDATE_FAILED,
        details: `Invalid or not found media index`,
      });
    }
  }

  _getNofMedias () {
    return this.medias.length + this.invalidMedias.length;
  }

  getAnswer () {
    // TODO can be simplified.
    let mediasToProcess = [];
    // Short exit: we have a single media. Probably a proper single m=* line
    // session or a multi m=* line where the adapter does it stuff right
    if (this._getNofMedias() === 1) {
      const media = this.medias[0] || this.invalidMedias[0];
      return media.localDescriptor;
    }
    this.medias.forEach((m) => {
      mediasToProcess[m.ortcIndex] = m;
    });
    this.invalidMedias.forEach((m) => {
      mediasToProcess[m.ortcIndex] = m;
    });
    mediasToProcess = mediasToProcess.filter(m => m);
    const validMedia = mediasToProcess.find(m => m.type !== C.MEDIA_TYPE.INTERNAL_UNSUPPORTED);

    if (!validMedia) {
      Logger.warn(LOG_PREFIX, `No supported media found for ${this.id}, rejecting it with MEDIA_NO_AVAILABLE_CODEC`);
      throw (this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
    }

    return mediasToProcess.map(m => {
      return m.localDescriptor
    });
  }

  _hasAvailableCodec () {
    // TODO codec matching
    return true;
  }
}
