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

module.exports = class SDPSession extends MediaSession {
  constructor(
    offer = null,
    room,
    user,
    type = 'WebRtcEndpoint',
    options
  ) {
    super(room, user, type, options);
    // {SdpWrapper} SdpWrapper
    this._offer;
    this._answer;

    if (offer) {
      this.setOffer(offer);
    }
  }

  setOffer (offer) {
    if (offer) {
      if (this._offer) {
        this._shouldRenegotiate = true;
      }

      this._offer = new SdpWrapper(offer, this.mediaSpecs, this._mediaProfile);
    }
  }

  setAnswer (answer) {
    if (answer) {
      this._answer = new SdpWrapper(answer, this.mediaSpecs, this._mediaProfile);
    }
  }

  async _defileAndProcess () {
    const {
      videoAdapter,
      audioAdapter,
      contentAdapter
    } = this._adapters;
    let videoMedias = [];
    let audioMedias = [];
    const videoDescription = this._offer.mainVideoSdp;
    const audioDescription = this._offer.audioSdp;

    if (videoDescription) {
      Logger.trace('[mcs-sdp-session] Processing multiadapter video SDP for', this.id, videoDescription);
      videoMedias = await videoAdapter.negotiate(this.roomId, this.userId, this.id,
        videoDescription, this._type, this._options);
    }

    if (audioDescription) {
      Logger.trace('[mcs-sdp-session] Processing multiadapter audio SDP for', this.id, audioDescription);
      audioMedias = await audioAdapter.negotiate(this.roomId, this.userId, this.id,
        audioDescription, this._type, this._options);
    }

    this.medias = this.medias.concat(videoMedias, audioMedias);

    const answer = this.getAnswer();
    this.setAnswer(answer);
    return answer;

  }

  renegotiateStreams () {
    return new Promise(async (resolve, reject) => {
      try {
        // For now we only support full renegotiation for content streams. Anything
        // else will be re-sent as previously processed
        const {
          contentAdapter
        } = this._adapters;

        if (this._offer.contentVideoSdp) {
          const contentMedias = await contentAdapter.negotiate(this.roomId, this.userId, this.id,
            this._offer.contentVideoSdp, this._type, this._options);

          this.medias = this.medias.concat(contentMedias);

          const contentAnswer = this.getAnswer();
          // TODO move the content:slides appendage to the kurento adapter
          this.setAnswer(contentAnswer + "a=content:slides\r\n");
          return resolve(contentAnswer + "a=content:slides\r\n");
        }

        return resolve(this.getAnswer());
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
        let answer;

        if (this._shouldRenegotiate) {
          answer = await this.renegotiateStreams();
          return resolve(answer);
        }

        if (AdapterFactory.isComposedAdapter(this._adapter)) {
          answer = await this._defileAndProcess(this._offer);
        } else {
          // The adapter is the same for all media types, so either one will suffice
          let offer = this._offer ? this._offer.plainSdp : null;
          this.medias = await videoAdapter.negotiate(this.roomId, this.userId, this.id, offer, this._type, this._options);
          answer = this.getAnswer();
          this.setAnswer(answer);
        }

        answer = (this._answer && this._answer._plainSdp)? this._answer._plainSdp : null;

        Logger.trace('[mcs-sdp-session] The wizard responsible for this session', this.id, 'processed the following answers', answer);

        // Checks if the media server was able to find a compatible media line
        if (this.medias.length <= 0) {
          return reject(this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
        }

        if (this._offer && answer) {
          if (!this._hasAvailableCodec()) {
            return reject(this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
          }

          this.mediaTypes.video = this._answer.hasAvailableVideoCodec();
          this.mediaTypes.audio = this._answer.hasAvailableAudioCodec();
          this.mediaTypes.content = this._answer.hasContent();
        }

        Logger.trace("[mcs-sdp-session] Answer SDP for session", this.id, answer);
        this.createAndSetMediaNames();
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_CONNECTED, this.getMediaInfo());

        return resolve(answer);
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
    if (this.medias[0]) {
      header = this.medias[0].answer.sessionDescriptionHeader;
    } else {
      return;
    }

    // Some endpoints demand that the audio description be first in order to work
    const headDescription = this.medias.filter(m => m.mediaTypes.audio);
    const remainingDescriptions = this.medias.filter(m => !m.mediaTypes.audio);

    if (headDescription && headDescription[0]) {
      body += headDescription[0].answer.removeSessionDescription(headDescription[0].answer._plainSdp);
    }

    remainingDescriptions.forEach(m => {
      const partialAnswer = m.answer;
      if (partialAnswer) {
        body += partialAnswer.removeSessionDescription(partialAnswer._plainSdp)
      }
    });

    return header + body;
  }

  _hasAvailableCodec () {
    return (this._offer.hasAvailableVideoCodec() === this._answer.hasAvailableVideoCodec()) &&
      (this._offer.hasAvailableAudioCodec() === this._answer.hasAvailableAudioCodec());
  }
}
