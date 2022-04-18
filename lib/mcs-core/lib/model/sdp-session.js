/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const SdpWrapper = require('../utils/sdp-wrapper');
const MediaSession = require('./media-session');
const InternalUnsupportedMedia = require('./int-unsupported-media.js');
const Logger = require('../utils/logger');
const AdapterFactory = require('../adapters/adapter-factory');
const GLOBAL_EVENT_EMITTER = require('../../../common/emitter.js');

module.exports = class SDPSession extends MediaSession {
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
    // {SdpWrapper} SdpWrapper
    this._remoteDescriptor;
    this._localDescriptor;

    this.negotiationRole = '';
    this.shouldRenegotiate = false;
    this.shouldProcessRemoteDescriptorAsAnswerer = false;

    if (remoteDescriptor) {
      this.remoteDescriptor = remoteDescriptor;
    }

    // FIXME sess-version workaround. Should be removed when the SDP header
    // is assembled uniquely by ourselves.
    this.firstLocalDescriptor = true;

    Logger.info("SDP session: created", this.getMediaInfo());
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

      if (this._options.hackForceActiveDirection) {
        this._remoteDescriptor.forceActiveDirection();
      }

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

  async _negotiateAudioMedias (descriptor = '') {
    const { audioAdapter } = this._adapters;
    // If descriptor comes in null, we're the offerer.
    // In this case, null should be handled by the adapter
    // as an indicator of offers needed to be generated.
    // Same thing goes for negotiateVideo/ContentMedias.
    // Set the media options according to the role we're performing. If we're the offerer,
    // we have to specify what're going to generate to the adapter manually.
    // Same thing goes for negotiateVideo/ContentMedias.
    const isAnswerer = this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER;
    const audioOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.AUDIO };
    audioOptions.profiles = SDPSession.filterProfilesByMType('audio', audioOptions.profiles);

    const shouldNegotiate = !!descriptor
      || (this.profiles.audio && !isAnswerer);

    if (shouldNegotiate) {
      const audioMedias = await audioAdapter.negotiate(
        this.roomId, this.userId, this.id,
        descriptor, this.type, audioOptions
      );
      audioMedias.forEach(m => {
        m.localDescriptor = m.localDescriptor.audioSdp;
        Logger.debug(`SDP session: composed adapter negotiation succeeded for audio media unit ${m.id}`, m.localDescriptor._plainSdp);
      });
      return audioMedias;
    } else {
      return [];
    }
  }

  async _negotiateVideoMedias (descriptor = '') {
    const { videoAdapter } = this._adapters;
    const isAnswerer = this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER;
    const videoOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.MAIN };
    videoOptions.profiles = SDPSession.filterProfilesByMType('video', videoOptions.profiles);

    const shouldNegotiate = !!descriptor
      || (this.profiles.video && !isAnswerer);

    if (shouldNegotiate) {
      const videoMedias = await videoAdapter.negotiate(
        this.roomId, this.userId, this.id,
        descriptor, this.type, videoOptions
      );
      videoMedias.forEach(m => {
        m.localDescriptor =  m.localDescriptor.mainVideoSdp;
        Logger.debug(`SDP session: composed adapter negotiation succeeded for video media unit ${m.id}`, m.localDescriptor._plainSdp);
      });
      return videoMedias;
    } else {
      return [];
    }
  }

  async _negotiateContentMedias (descriptor = '') {
    const { contentAdapter } = this._adapters;
    const isAnswerer = this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER;
    const contentOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.CONTENT };
    contentOptions.profiles = SDPSession.filterProfilesByMType('content', contentOptions.profiles);

    const shouldNegotiate = !!descriptor
      || (this.profiles.content && !isAnswerer);

    if (shouldNegotiate) {
      const contentMedias = await contentAdapter.negotiate(
        this.roomId, this.userId, this.id, descriptor,
        this.type, contentOptions
      );
      contentMedias.forEach(m => {
        m.localDescriptor = m.localDescriptor.contentVideoSdp;
        Logger.debug(`SDP session: composed adapter negotiation succeeded for content media unit ${m.id}`, m.localDescriptor._plainSdp);
      });
      return contentMedias;
    } else {
      return [];
    }
  }

  async _negotiateApplicationMedias (descriptor) {
    return this._rejectMedias(descriptor);
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

  async _composedAdapterProcess () {
    const remoteDescriptor = this.remoteDescriptor
      ? this.remoteDescriptor._plainSdp
      : '';
    let {
      numberOfMediaLines,
      annotatedDescriptors: annotatedPartialDescriptors,
    } = SdpWrapper.getAnnotatedPartialDescriptors(remoteDescriptor);
    const processMethods = {
      [C.MEDIA_PROFILE.AUDIO]: this._negotiateAudioMedias.bind(this),
      [C.MEDIA_PROFILE.MAIN]: this._negotiateVideoMedias.bind(this),
      [C.MEDIA_PROFILE.CONTENT]: this._negotiateContentMedias.bind(this),
      [C.MEDIA_PROFILE.APPLICATION]: this._negotiateApplicationMedias.bind(this),
      [C.MEDIA_PROFILE.UNSUPPORTED]: this._rejectMedias.bind(this),
    };

    return Object.keys(annotatedPartialDescriptors).reduce((promise, type) => {
      return promise.then(() => {
        const { descriptor, indexes } = annotatedPartialDescriptors[type];
        return processMethods[type](descriptor)
          .then(processedMedias => {
            processedMedias.forEach((mediaUnit, adapterIndex) => {
              let sdpPosition;
              // if block: we have a mapping of the partial descriptor indexes to the adapter
              // processing index. Keep in mind that the indexes array returned
              // in the annotatedDescriptorEntry is the overall position of then
              // m=* line in the ENTIRE REMOTE DESCRIPTOR. The adapters MUST
              // process m=* lines in order if they need to do so separately,
              // so the adapterIndex should server as the correct index to fetch
              // the original SDP position in indexes
              if (typeof indexes[adapterIndex] !== 'undefined') {
                sdpPosition = indexes[adapterIndex];
              } else {
                // else block: we don't have a mapping. This means this is a new
                // media from US as the OFFERERS. The position will be right after
                // the LAST processed media indicated by the numberOfMediaLines
                // (or 0).
                sdpPosition = numberOfMediaLines;
                numberOfMediaLines = numberOfMediaLines += 1;
              }
              mediaUnit.sdpPosition = sdpPosition;
              if (mediaUnit.type !== C.MEDIA_TYPE.INTERNAL_UNSUPPORTED) {
                this.medias.push(mediaUnit);
              } else {
                this.invalidMedias.push(mediaUnit);
              }
            });
          })
          .catch(error => {
            // TODO would be cool to deactivate medias that failed to be negotiated
            // if they were from a negotiation from the remote end.
            Logger.error(`SDP session: failed to negotiate ${type} medias due to ${error.message}`,
              { error: this._handleError(error) });
        });
      });
    }, Promise.resolve()).then(() => {
      Logger.info(`SDP session: composed adapter processing finished for ${this.id}`);
    }).catch(error => {
      const normalizedError = this._handleError(error);
      Logger.error(`SDP session: composed adapter process error on promise chain ${error.message}`,
        { error: normalizedError });
    });
  }

  _monoAdapterProcess () {
    // The adapter is the same for all media types, so either one will suffice
    const remoteDescriptor = this.remoteDescriptor ? this.remoteDescriptor.plainSdp : null;
    return this._adapters.videoAdapter.negotiate(this.roomId, this.userId, this.id, remoteDescriptor, this.type, this._options)
      .then(medias => {
        medias.forEach((m, index) => {
          m.sdpPosition = index;
        });
        this.medias = this.medias.concat(medias);
      })
      .catch(error => {
        throw error;
      });
  }

  // FIXME Man... this SUCKS
  // FIXME FIXME FIXME
  async renegotiateStreams () {
    try {
      const {
        videoAdapter,
        audioAdapter,
        contentAdapter
      } = this._adapters;

      // Short exit: we have a single media. Probably a proper single m=* line
      // session or a multi m=* line where the adapter does it stuff right
      if (this._getNofMedias() === 1) {
        const tMedia = this.medias[0];
        try {
          if (tMedia) {
            Logger.trace('SDP session: processing unified answerer streams', {
              mediaSessionId: this.id,
              mediaId: tMedia.id,
              descriptor: this.remoteDescriptor.plainSdp,
            });

            await videoAdapter.processAnswer(
              tMedia.adapterElementId,
              this.remoteDescriptor.plainSdp,
              { mediaTypes: tMedia.mediaTypes, ...this._options }
            );

            tMedia.remoteDescriptor = this.remoteDescriptor.plainSdp;
          } else {
            throw ({
              ...C.ERROR.MEDIA_NOT_FOUND,
              details: 'No unified media on renegotiation',
            });
          }

          this.localDescriptor = this.getAnswer();
          return this.localDescriptor.plainSdp;
        } catch (error) {
          Logger.error('SDP session: renegotiation failed',
            { roomId: this.roomId, userId: this.userId, mediaSessionId: this.id, error }
          );
          throw error;
        }
      }

      // There are checks here for shouldProcessRemoteDescriptorAsAnswerer because
      // we don't support full, unlimited renegotiation as of now due to media
      // server limitations. I understand this is kinda coupling the session
      // logic to a limitation of Kurento and this should be handled there.
      // Also, this method works well, but it needs a refactor to be similar
      // to composedAdapterNegotiation (or even re-use it). Needs a media server
      // adapter data interfacing review, though.
      // I'll do it once I have time - prlanzarin 31/10/2019 FIXME
      if (this.remoteDescriptor.mainVideoSdp && this.shouldProcessRemoteDescriptorAsAnswerer) {
        try {
          const videoMedia = this.medias.find(m => m.mediaTypes.video);

          if (videoMedia) {
            Logger.trace('SDP session: processing answerer video streams', {
              mediaSessionId: this.id,
              mediaId: videoMedia.id,
              descriptor: this.remoteDescriptor.mainVideoSdp,
            });

            await videoAdapter.processAnswer(
              videoMedia.adapterElementId,
              this.remoteDescriptor.mainVideoSdp,
              { mediaTypes: videoMedia.mediaTypes, ...this._options }
            );

            videoMedia.remoteDescriptor = this.remoteDescriptor.mainVideoSdp;
          } else {
            throw ({
              ...C.ERROR.MEDIA_NOT_FOUND,
              details: 'No video media on renegotiation',
            });
          }
        } catch (error) {
          Logger.error('SDP session: video renegotiation failed',
            { roomId: this.roomId, userId: this.userId, mediaSessionId: this.id, error }
          );
        }
      }

      if (this.remoteDescriptor.audioSdp && this.shouldProcessRemoteDescriptorAsAnswerer) {
        try {
          const audioMedia = this.medias.find(m => m.mediaTypes.audio);

          if (audioMedia) {
            Logger.trace('SDP session: processing answerer audio streams', {
              mediaSessionId: this.id,
              mediaId: audioMedia.id,
              descriptor: this.remoteDescriptor.audioSdp,
            });
            const adescBody = SdpWrapper.removeSessionDescription(this.remoteDescriptor.audioSdp);
            const mainWithInvalidVideo = this.remoteDescriptor.sessionDescriptionHeader + adescBody;
            await audioAdapter.processAnswer(
              audioMedia.adapterElementId,
              mainWithInvalidVideo,
              { mediaTypes: audioMedia.mediaTypes, ...this._options }
            );

            audioMedia.remoteDescriptor = this.remoteDescriptor.audioSdp;
          } else {
            throw this._handleError({
              ...C.ERROR.MEDIA_NOT_FOUND,
              details: 'No audio media on renegotiation',
            });
          }
        } catch (error) {
          Logger.error('SDP session: audio renegotiation failed',
            { roomId: this.roomId, userId: this.userId, mediaSessionId: this.id, error }
          );
        }
      }

      if (this.remoteDescriptor.invalidSdps
        && (!this.localDescriptor || !this.localDescriptor.invalidSdps)) {
        const rejectedMedias = await this._rejectMedias(this.remoteDescriptor.invalidSdps);
        let currentMediaLength = this.medias.length + this.invalidMedias.length;
        rejectedMedias.forEach(rm => {
          rm.sdpPosition = currentMediaLength;
          currentMediaLength +=1;
        });
        this.invalidMedias = this.invalidMedias.concat(rejectedMedias);
      }

      if (this.remoteDescriptor.contentVideoSdp) {
        // This is an ANSWERER descriptor to us (as OFFERERS)
        if (this.shouldProcessRemoteDescriptorAsAnswerer || (this.localDescriptor && this.localDescriptor.contentVideoSdp)) {
          try {
            const contentMedia = this.medias.find(m => m.mediaTypes.content);

            if (contentMedia) {
              Logger.trace('SDP session: processing answerer content streams', {
                mediaSessionId: this.id,
                mediaId: contentMedia.id,
                descriptor: this.remoteDescriptor.contentVideoSdp,
              });

              await contentAdapter.processAnswer(
                contentMedia.adapterElementId,
                this.remoteDescriptor.contentVideoSdp,
                { mediaTypes: contentMedia.mediaTypes, ...this._options }
              );

              contentMedia.remoteDescriptor = this.remoteDescriptor.contentVideoSdp;
            } else {
              throw this._handleError({
                ...C.ERROR.MEDIA_NOT_FOUND,
                details: 'No content media on renegotiation',
              });
            }
          } catch (error) {
            Logger.error('SDP session: content renegotiation failed',
              { roomId: this.roomId, userId: this.userId, mediaSessionId: this.id, error }
            );
          }
        } else if (!this.localDescriptor || !this.localDescriptor.contentVideoSdp) {
          // This is a renegotiation for a new content media for us as ANSWERERS
          Logger.trace("SDP session: renegotiating content streams", {
            mediaSessionId: this.id,
            descriptor: this.remoteDescriptor.contentVideoSdp,
          });

          try {
            const contentMedias = await this._negotiateContentMedias(this.remoteDescriptor.contentVideoSdp);
            let currentMediaLength = this.medias.length + this.invalidMedias.length;
            contentMedias.forEach(cm => {
              cm.sdpPosition = currentMediaLength;
              currentMediaLength +=1;
            });
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
            let currentMediaLength = this.medias.length + this.invalidMedias.length;
            contentMedias.forEach(cm => {
              cm.sdpPosition = currentMediaLength;
              currentMediaLength +=1;
            });
            this.medias = this.medias.concat(contentMedias);
          } catch (e) {
            this._handleError(e);
          }
        } catch (e) {
          this._handleError(e);
        }
      }

      this.localDescriptor = this.getAnswer();

      return this.localDescriptor._plainSdp;
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
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_RENEGOTIATED, this.getMediaInfo());
        return localDescriptorAnswer;
      } catch (e) {
        throw (this._handleError(e));
      }
    }

    try {
      await processMethod();
    } catch (error) {
      Logger.error(`SDP session: failed to process SDP session ${this.id} due to ${error.message}`,
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

    Logger.trace(`SDP session: answer SDP for session ${this.id}`, { localDescriptorAnswer });
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
          Logger.warn(`SDP session: failed to add ICE candidate`, {
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
    let header = '', body = '';
    let mediasToProcess = [];
    // Short exit: we have a single media. Probably a proper single m=* line
    // session or a multi m=* line where the adapter does it stuff right
    if (this._getNofMedias() === 1) {
      const media = this.medias[0] || this.invalidMedias[0];
      return media.localDescriptor._plainSdp;
    }
    this.medias.forEach((m) => {
      mediasToProcess[m.sdpPosition] = m;
    });
    this.invalidMedias.forEach((m) => {
      mediasToProcess[m.sdpPosition] = m;
    });
    mediasToProcess = mediasToProcess.filter(m => m);
    const validMedia = mediasToProcess.find(m => m.type !== C.MEDIA_TYPE.INTERNAL_UNSUPPORTED);

    // TODO we should have a fallback SDP header for this case instead
    // of churning a NO_AVAILABLE_CODEC error
    if (!validMedia) {
      Logger.warn(`SDP session: no supported media found for ${this.id}, rejecting it with MEDIA_NO_AVAILABLE_CODEC`);
      throw (this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
    }

    // FIXME sess-version workaround. Should be removed when the SDP header
    // is assembled uniquely by ourselves.
    if (this.firstLocalDescriptor) {
      this.firstLocalDescriptor= false
    } else {
      validMedia.localDescriptor.incrementSessVer();
    }

    header = validMedia.localDescriptor.sessionDescriptionHeader;

    mediasToProcess.forEach(m => {
      const partialLocalDescriptor = m.localDescriptor;
      if (partialLocalDescriptor) {
        body += SdpWrapper.removeSessionDescription(partialLocalDescriptor._plainSdp)
      }
    });

    return header + body;
  }

  _hasAvailableCodec () {
    return (this.remoteDescriptor.hasAvailableVideoCodec() === this.localDescriptor.hasAvailableVideoCodec()) &&
      (this.remoteDescriptor.hasAvailableAudioCodec() === this.localDescriptor.hasAvailableAudioCodec());
  }
}
