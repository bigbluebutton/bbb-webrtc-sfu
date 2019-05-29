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
    }
  }

  set shouldProcessRemoteDescriptorAsAnswerer (value) {
    if (value === true && !this.shouldProcessRemoteDescriptorAsAnswerer) {
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_CONNECTED, this.getMediaInfo());
    }

    this._shouldProcessRemoteDescriptorAsAnswerer = value;
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
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  async _defileAndProcess () {
    const {
      videoAdapter,
      audioAdapter,
      contentAdapter
    } = this._adapters;

    let videoMedias = [];
    let audioMedias = [];
    let contentMedias = [];

    const videoDescription = this.remoteDescriptor? this.remoteDescriptor.mainVideoSdp : null;
    const audioDescription = this.remoteDescriptor? this.remoteDescriptor.audioSdp : null;
    const contentDescription = this.remoteDescriptor? this.remoteDescriptor.contentVideoSdp : null;

    try {
      audioMedias = await audioAdapter.negotiate(this.roomId, this.userId, this.id,
        audioDescription, this._type, this._options);
      audioMedias.forEach(m => {
        m.localDescriptor = SdpWrapper.getAudioSDP(m.localDescriptor._plainSdp)
      });
    } catch (e) {
      this._handleError(e);
    }

    try {
      videoMedias = await videoAdapter.negotiate(this.roomId, this.userId, this.id,
        videoDescription, this._type, this._options);
      videoMedias.forEach(m => {
        const partialLocalDescriptor = m.localDescriptor._plainSdp;
        const mainDescriptor = `${SdpWrapper.getVideoSDP(partialLocalDescriptor)}a=content:main` ;
        m.localDescriptor = mainDescriptor;
      });
    } catch (e) {
      this._handleError(e);
    }

    try {
      contentMedias = await contentAdapter.negotiate(this.roomId, this.userId, this.id,
        contentDescription, this._type, this._options);
      contentMedias.forEach(m => {
        const partialLocalDescriptor = m.localDescriptor._plainSdp;
        const contentDescriptor = `${SdpWrapper.getVideoSDP(partialLocalDescriptor)}a=content:slides`
        m.localDescriptor = contentDescriptor;
      });
    } catch (e) {
      this._handleError(e);
    }

    this.medias = this.medias.concat(audioMedias, videoMedias, contentMedias);

    const localDescriptor = this.getAnswer();
    this.localDescriptor = localDescriptor;
    return localDescriptor;
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
            Logger.info(LOG_PREFIX, "Processing answerer video streams for", this.id);
            const videoMedia = this.medias.find(m => m.mediaTypes.video);
            const descBody = this.remoteDescriptor.removeSessionDescription(this.remoteDescriptor.mainVideoSdp);
            const mainWithInvalidAudio = this.remoteDescriptor.sessionDescriptionHeader + 'm=audio 0 RTP/AVP 96 97\n\ra=inactive\n\r' + descBody;
            await videoAdapter.processAnswer(videoMedia.adapterElementId, mainWithInvalidAudio);
            videoMedia.remoteDescriptor = this.remoteDescriptor.mainVideoSdp;
          } catch (e) {
            this._handleError(e);
          }
        }

        if (this.remoteDescriptor.audioSdp && this.shouldProcessRemoteDescriptorAsAnswerer) {
          try {
            Logger.info(LOG_PREFIX, "Processing answerer audio streams for", this.id);
            const audioMedia = this.medias.find(m => m.mediaTypes.audio);
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
          if (this.shouldProcessRemoteDescriptorAsAnswerer) {
            Logger.info(LOG_PREFIX, `Processing answerer content streams for ${this.id} ${this.remoteDescriptor.contentVideoSdp}`);
            const contentMedia = this.medias.find(m => m.mediaTypes.content);
            const descBody = this.remoteDescriptor.removeSessionDescription(this.remoteDescriptor.contentVideoSdp);
            const contentWithInvalidAudio = this.remoteDescriptor.sessionDescriptionHeader + 'm=audio 0 RTP/AVP 96 97\n\ra=inactive\n\r' + descBody;
            await contentAdapter.processAnswer(contentMedia.adapterElementId, contentWithInvalidAudio);
            contentMedia.remoteDescriptor = this.remoteDescriptor.contentVideoSdp;
          } else if (!this.localDescriptor || !this.localDescriptor.contentVideoSdp) {
          Logger.info(LOG_PREFIX, "Renegotiating content streams for", this.id, this.remoteDescriptor.contentVideoSdp)
            try {
              const contentMedias = await contentAdapter.negotiate(this.roomId, this.userId, this.id,
                this.remoteDescriptor.contentVideoSdp, this._type, this._options);
              this.medias = this.medias.concat(contentMedias);
            } catch (e) {
              this._handleError(e);
            }
          }
        }

        this.localDescriptor = this.getAnswer();

        return resolve(this.localDescriptor._plainSdp);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }

  process () {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          videoAdapter,
          audioAdapter,
          contentAdapter
        } = this._adapters;
        let localDescriptor;

        // If this is marked for renegotiation, do it
        if (this.shouldRenegotiate || this.shouldProcessRemoteDescriptorAsAnswerer) {
          try {
            localDescriptor = await this.renegotiateStreams();
            if (this.shouldProcessRemoteDescriptorAsAnswerer) {
              this.shouldProcessRemoteDescriptorAsAnswerer = false;
            }
            return resolve(localDescriptor);
          } catch (e) {
            return reject(this._handleError(e));
          }
        }

        if (AdapterFactory.isComposedAdapter(this._adapter)) {
          localDescriptor = await this._defileAndProcess(this.remoteDescriptor);
        } else {
          // The adapter is the same for all media types, so either one will suffice
          let remoteDescriptor = this.remoteDescriptor ? this.remoteDescriptor.plainSdp : null;
          this.medias = await videoAdapter.negotiate(this.roomId, this.userId, this.id, remoteDescriptor, this._type, this._options);
          localDescriptor = this.getAnswer();
          this.localDescriptor = localDescriptor;
        }

        localDescriptor = (this.localDescriptor && this.localDescriptor._plainSdp)? this.localDescriptor._plainSdp : null;

        Logger.trace('[mcs-sdp-session] The wizard responsible for this session', this.id, 'processed the following localDescriptors', localDescriptor);

        // Checks if the media server was able to find a compatible media line
        if (this.medias.length <= 0 && this.remoteDescriptor) {
          return reject(this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
        }

        if (this.remoteDescriptor && localDescriptor) {
          if (!this._hasAvailableCodec()) {
            return reject(this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
          }

        }

        if (localDescriptor) {
          this.mediaTypes.video = this.localDescriptor.hasAvailableVideoCodec();
          this.mediaTypes.audio = this.localDescriptor.hasAvailableAudioCodec();
          this.mediaTypes.content = this.localDescriptor.hasContent();
        }

        Logger.trace("[mcs-sdp-session] Answer SDP for session", this.id, localDescriptor);
        this.createAndSetMediaNames();

        // We only emit the MEDIA_CONNECTED event when the negotiation has been
        // sucessfully enacted. In the case where we are the answerer, we fire it
        // here. If we are the offerer, we fire it when the answer is properly
        // processed and the shouldProcessRemoteDescriptorAsAnswerer flag is
        // deactivated
        if (this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER) {
          GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_CONNECTED, this.getMediaInfo());
        }

        return resolve(localDescriptor);
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
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
