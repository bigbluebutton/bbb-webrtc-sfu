/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const SdpWrapper = require('../utils/sdp-wrapper');
const rid = require('readable-id');
const MediaSession = require('./media-session');
const SDPMedia = require('./sdp-media');
const config = require('config');
const Logger = require('../utils/logger');
const AdapterFactory = require('../adapters/adapter-factory');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const Balancer = require('../media/balancer');
const LOG_PREFIX = "[mcs-sdp-session]";

module.exports = class SDPSession extends MediaSession {
  constructor(
    remoteDescriptor = null,
    room,
    user,
    type = 'WebRtcEndpoint',
    options
  ) {
    super(room, user, type, options);
    // {SdpWrapper} SdpWrapper
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

      this._remoteDescriptor = new SdpWrapper(remoteDescriptor, this.mediaSpecs, this._mediaProfile);

      if (this.negotiationRole === C.NEGOTIATION_ROLE.OFFERER) {
        this.mediaSpecs = SdpWrapper.updateSpecWithChosenCodecs(this.remoteDescriptor);
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
      this._localDescriptor = new SdpWrapper(localDescriptor, this.mediaSpecs, this._mediaProfile);

      if (this.remoteDescriptor == null && !this.negotiationRole) {
        this.negotiationRole = C.NEGOTIATION_ROLE.OFFERER;
      }

      if (this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER) {
        this.mediaSpecs = SdpWrapper.updateSpecWithChosenCodecs(this.localDescriptor);
      }
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  async _negotiateAudioMedias () {
    Logger.debug(LOG_PREFIX, `Composed adapter negotiation for audio medias requested at session ${this.id}`);
    const { audioAdapter } = this._adapters;
    // Check if we have a remote descriptor yet. If not, we're the offerer.
    // In this case, the descriptor is just null and should be handled by the adapter
    // as an indicator of offers needed to be generated.
    // Same thing goes for negotiateVideo/ContentMedias.
    const audioDescription = this.remoteDescriptor? this.remoteDescriptor.audioSdp : null;
    // Set the media options according to the role we're performing. If we're the offerer,
    // we have to specify what're going to generate to the adapter manually.
    // Same thing goes for negotiateVideo/ContentMedias.
    const isAnswerer = this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER;
    const audioOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.AUDIO };
    if (this.profiles.audio || audioDescription) {
      try {
        const audioMedias = await audioAdapter.negotiate(
          this.roomId, this.userId, this.id,
          audioDescription, this.type, audioOptions
        );
        audioMedias.forEach(m => {
          m.localDescriptor = SdpWrapper.getAudioSDP(m.localDescriptor._plainSdp)
          Logger.debug(LOG_PREFIX, `Composed adapter negotiation succeeded for audio media unit ${m.id}`, m.localDescriptor._plainSdp)
        });
        return audioMedias;
      } catch (e) {
        throw e;
      }
    } else {
      return [];
    }
  }

  async _negotiateVideoMedias () {
    Logger.debug(LOG_PREFIX, `Composed adapter negotiation for video medias requested at session ${this.id}`);
    const { videoAdapter } = this._adapters;
    const videoDescription = this.remoteDescriptor? this.remoteDescriptor.mainVideoSdp : null;
    const isAnswerer = this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER;
    const videoOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.MAIN };

    if (this.profiles.video || videoDescription) {
      try {
        const videoMedias = await videoAdapter.negotiate(
          this.roomId, this.userId, this.id,
          videoDescription, this.type, videoOptions
        );
        videoMedias.forEach(m => {
          m.localDescriptor =  SdpWrapper.getVideoSDP(m.localDescriptor._plainSdp);
          Logger.debug(LOG_PREFIX, `Composed adapter negotiation succeeded for video media unit ${m.id}`, m.localDescriptor._plainSdp)
        });
        return videoMedias;
      } catch (e) {
        throw e;
      }
    } else {
      return [];
    }
  }

  async _negotiateContentMedias () {
    Logger.debug(LOG_PREFIX, `Composed adapter negotiation for video medias requested at session ${this.id}`);
    const { contentAdapter } = this._adapters;
    const contentDescription = this.remoteDescriptor? this.remoteDescriptor.contentVideoSdp : null;
    const isAnswerer = this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER;
    const contentOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.CONTENT };
    if (this.profiles.content || contentDescription) {
      try {
        const contentMedias = await contentAdapter.negotiate(
          this.roomId, this.userId, this.id, contentDescription,
          this.type, contentOptions
        );
        contentMedias.forEach(m => {
          m.localDescriptor = SdpWrapper.getContentSDP(m.localDescriptor._plainSdp);
          Logger.debug(LOG_PREFIX, `Composed adapter negotiation succeeded for content media unit ${m.id}`, m.localDescriptor._plainSdp)
        });
        return contentMedias;
      } catch (e) {
        throw e;
      }
    } else {
      return [];
    }
  }

  async _composedAdapterProcess () {
    let audioMedias = [];
    let videoMedias = [];
    let contentMedias = [];

    try {
      audioMedias = await this._negotiateAudioMedias();
    } catch (error) {
      Logger.error(LOG_PREFIX, "Failed to negotiate audio medias, none will be generated", { error });
    }
    try {
      videoMedias = await this._negotiateVideoMedias();
    } catch (error) {
      Logger.error(LOG_PREFIX, "Failed to negotiate video medias, none will be generated", { error });
    }
    try {
      contentMedias = await this._negotiateContentMedias();
    } catch (error) {
      Logger.error(LOG_PREFIX, "Failed to negotiate content medias, none will be generated", { error });
    }

    return this.medias.concat(audioMedias, videoMedias, contentMedias);
  }

  _monoAdapterProcess () {
    // The adapter is the same for all media types, so either one will suffice
    const remoteDescriptor = this.remoteDescriptor ? this.remoteDescriptor.plainSdp : null;
    return this._adapters.videoAdapter.negotiate(this.roomId, this.userId, this.id, remoteDescriptor, this.type, this._options);
  }

  renegotiateStreams () {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          videoAdapter,
          audioAdapter,
          contentAdapter
        } = this._adapters;

        // There are checks here for shouldProcessRemoteDescriptorAsAnswerer because
        // we don't support full, unlimited renegotiation as of now due to media
        // server limitations. I understand this is kinda coupling the session
        // logic to a limitation of Kurento and this should be handled there.
        // I'll do it once I have time - prlanzarin 25/04/2018 FIXME
        if (this.remoteDescriptor.mainVideoSdp && this.shouldProcessRemoteDescriptorAsAnswerer) {
          try {
            const videoMedia = this.medias.find(m => m.mediaTypes.video);
            Logger.info(LOG_PREFIX, `Processing answerer video streams for session ${this.id} at media ${videoMedia.id}: ${this.remoteDescriptor.mainVideoSdp}`);
            await videoAdapter.processAnswer(videoMedia.adapterElementId, this.remoteDescriptor.mainVideoSdp, true);
            videoMedia.remoteDescriptor = this.remoteDescriptor.mainVideoSdp;
          } catch (e) {
            this._handleError(e);
          }
        }

        if (this.remoteDescriptor.audioSdp && this.shouldProcessRemoteDescriptorAsAnswerer) {
          try {
            const audioMedia = this.medias.find(m => m.mediaTypes.audio);
            Logger.info(LOG_PREFIX, `Processing answerer audio streams for session ${this.id} at media ${audioMedia.id}: ${this.remoteDescriptor.audioSdp}`);
            const adescBody = this.remoteDescriptor.removeSessionDescription(this.remoteDescriptor.audioSdp);
            const mainWithInvalidVideo = this.remoteDescriptor.sessionDescriptionHeader + adescBody;
            await audioAdapter.processAnswer(audioMedia.adapterElementId, mainWithInvalidVideo);
            audioMedia.remoteDescriptor = this.remoteDescriptor.audioSdp;
          }
          catch (e) {
            this._handleError(e);
          }
        }

        if (this.remoteDescriptor.contentVideoSdp) {
          // This is an ANSWERER descriptor to us (as OFFERERS)
          if (this.shouldProcessRemoteDescriptorAsAnswerer || (this.localDescriptor && this.localDescriptor.contentVideoSdp)) {
            const contentMedia = this.medias.find(m => m.mediaTypes.content);
            Logger.info(LOG_PREFIX, `Processing answerer content streams for session ${this.id} at media ${contentMedia.id}: ${this.remoteDescriptor.contentVideoSdp}`);
            await contentAdapter.processAnswer(contentMedia.adapterElementId, this.remoteDescriptor.contentVideoSdp, true);
            contentMedia.remoteDescriptor = this.remoteDescriptor.contentVideoSdp;
          } else if (!this.localDescriptor || !this.localDescriptor.contentVideoSdp) {
            // This is a renegotiation for a new content media for us as ANSWERERS
            Logger.info(LOG_PREFIX, "Renegotiating content streams for", this.id, this.remoteDescriptor.contentVideoSdp);
            try {
              const contentMedias = await this._negotiateContentMedias();
              this.medias = this.medias.concat(contentMedias);
            } catch (e) {
              this._handleError(e);
            }
          }
        } else if (this.profiles.content) {
          // Late content offer request on a renegotiation (we as OFFERERS)
          try {
            try {
              const contentMedias = await this._negotiateContentMedias();
              this.medias = this.medias.concat(contentMedias);
            } catch (e) {
              this._handleError(e);
            }
          } catch (e) {
            this._handleError(e);
          }
        }

        this.localDescriptor = this.getAnswer();

        return resolve(this.localDescriptor._plainSdp);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
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

  _hasCompleteLocalDescriptor () {
    return this.localDescriptor && this.localDescriptor._plainSdp;
  }

  async process () {
    let localDescriptorAnswer;
    const processMethod = AdapterFactory.isComposedAdapter(this._adapter)
      ? this._composedAdapterProcess.bind(this)
      : this._monoAdapterProcess.bind(this);

    // If this is marked for renegotiation, do it
    if (this.shouldRenegotiate || this.shouldProcessRemoteDescriptorAsAnswerer) {
      try {
        localDescriptorAnswer = await this.renegotiateStreams();
        if (this.shouldProcessRemoteDescriptorAsAnswerer) {
          this.shouldProcessRemoteDescriptorAsAnswerer = false;
        }
        return localDescriptorAnswer;
      } catch (e) {
        throw (this._handleError(e));
      }
    }

    try {
      this.medias = await processMethod();
    } catch (error) {
      Logger.error(LOG_PREFIX, `Failed to process SDP session ${this.id} due to ${error.message}`,
        { roomId: this.roomId, userId: this.userId, mediaSessionId: this.id, error });
      throw (this._handleError(error));
    }

    this.localDescriptor = this.getAnswer();
    localDescriptorAnswer = this._hasCompleteLocalDescriptor()
      ? this.localDescriptor._plainSdp
      : null;

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

    Logger.trace(LOG_PREFIX, `Answer SDP for session ${this.id}`, { localDescriptorAnswer });
    return localDescriptorAnswer;
  }

  fillMediaTypes () {
    this.mediaTypes.video = this.medias.some(m => m.mediaTypes.video);
    this.mediaTypes.content = this.medias.some(m => m.mediaTypes.content) || this._mediaProfile === C.MEDIA_PROFILE.CONTENT;
    this.mediaTypes.audio = this.medias.some(m => m.mediaTypes.audio);
  }

  addIceCandidate (candidate) {
    return new Promise(async (resolve, reject) => {
      try {
        this.medias.forEach(m => {
          if (m.type === C.MEDIA_TYPE.WEBRTC) {
            m.addIceCandidate(candidate);
          }
        });
        resolve();
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  getAnswer () {
    let header = '', body = '';

    // Some endpoints demand that the audio description be first in order to work
    // FIXME this should be reviewed. The m= lines  order should match the
    // offer order, otherwise the Unified Plan partisans will complain
    const headDescription = this.medias.filter(m => m.mediaTypes.audio);
    const remainingDescriptions = this.medias.filter(m => !m.mediaTypes.audio);

    if (remainingDescriptions && remainingDescriptions[0]) {
      header = remainingDescriptions[0].localDescriptor.sessionDescriptionHeader;
    } else  if (this.medias[0]) {
      header = this.medias[0].localDescriptor.sessionDescriptionHeader;
    } else {
      return;
    }

    if (headDescription && headDescription[0]) {
      body += headDescription[0].localDescriptor.removeSessionDescription(headDescription[0].localDescriptor._plainSdp);
    }

    remainingDescriptions.forEach(m => {
      const partialLocalDescriptor = m.localDescriptor;
      if (partialLocalDescriptor) {
        body += partialLocalDescriptor.removeSessionDescription(partialLocalDescriptor._plainSdp)
      }
    });

    return header + body;
  }

  _hasAvailableCodec () {
    return (this.remoteDescriptor.hasAvailableVideoCodec() === this.localDescriptor.hasAvailableVideoCodec()) &&
      (this.remoteDescriptor.hasAvailableAudioCodec() === this.localDescriptor.hasAvailableAudioCodec());
  }
}
