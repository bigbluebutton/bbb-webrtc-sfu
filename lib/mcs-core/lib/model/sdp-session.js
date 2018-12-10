/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const SdpWrapper = require('../utils/sdp-wrapper');
const rid = require('readable-id');
const MediaSession = require('./media-session');
const config = require('config');
const Logger = require('../utils/logger');
const AdapterFactory = require('../adapters/adapter-factory');
const MEDIA_SPECS = config.get('conference-media-specs');

module.exports = class SdpSession extends MediaSession {
  constructor(
    offer = null,
    room,
    user,
    type = 'WebRtcEndpoint',
    options
  ) {
    super(room, user, type, options);
    Logger.info("[mcs-sdp-session] New session with options", type, options);
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

      this._offer = new SdpWrapper(offer, MEDIA_SPECS, this._mediaProfile);
    }
  }

  setAnswer (answer) {
    if (answer) {
      this._answer = new SdpWrapper(answer, MEDIA_SPECS, this._mediaProfile);
    }
  }

  async _defileAndProcess () {
    const {
      videoAdapter,
      audioAdapter,
      contentAdapter
    } = this._adapters;

    const videoDescription = this._offer.mainVideoSdp;
    const audioDescription = this._offer.audioSdp;
    Logger.trace('[mcs-sdp-session] Defiling this beloved SDP for session', this.id, videoDescription, audioDescription);
    const videoAnswer = videoAdapter.processOffer(this.videoMediaElement,
      videoDescription, { name: this._name });
    const audioAnswer = audioAdapter.processOffer(this.audioMediaElement,
      audioDescription, { name: this._name });

    audioAdapter.once(C.EVENT.MEDIA_DISCONNECTED+this.audioMediaElement, this.stop.bind(this));
    videoAdapter.once(C.EVENT.MEDIA_DISCONNECTED+this.videoMediaElement, this.stop.bind(this))

    this.setAnswer(audioAnswer + this._offer.removeSessionDescription(videoAnswer));
    return this._answer._plainSdp;

  }

  renegotiateStreams () {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          videoAdapter,
          audioAdapter,
          contentAdapter
        } = this._adapters;

        if (this._offer.contentVideoSdp) {
          const { mediaElement, host } = await contentAdapter.createMediaElement(this.roomId, this._type, this._options);

          this.contentMediaElement = mediaElement;
          this.contentHost = host;
          let contentAnswer = await videoAdapter.processOffer(this.contentMediaElement,
            this._offer.contentVideoSdp,
            { name: this._name }
          );
          contentAnswer = this._offer.removeSessionDescription(contentAnswer);
          this.setAnswer(this._answer._plainSdp + contentAnswer + "a=content:slides\r\n");
          return resolve(this._answer._plainSdp);
        }
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
          answer = await videoAdapter.processOffer(this.videoMediaElement,
            offer,
            { name: this._name }
          );
          videoAdapter.once(C.EVENT.MEDIA_DISCONNECTED+this.videoMediaElement, this.stop.bind(this));

          this.setAnswer(answer);
        }

        answer = this._answer._plainSdp? this._answer._plainSdp : null;

        Logger.trace('[mcs-sdp-session] The wizard responsible for this session', this.id, 'processed the following answers', answer);

        // Checks if the media server was able to find a compatible media line
        if (this._offer && answer) {
          // TODO review codec checking
          //if (!this._hasAvailableCodec()) {
          //  return reject(this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
          //}

          this._mediaTypes.video = this._answer.hasAvailableVideoCodec();
          this._mediaTypes.audio = this._answer.hasAvailableAudioCodec();
        }

        // TODO review the whole videoHost/audioHost flow, too messy
        if (answer && this._type !== 'WebRtcEndpoint') {
          answer = SdpWrapper.nonPureReplaceServerIpv4(answer, this.videoHost.ip);
        }

        // TODO gather candidates for every media element in the session
        if (this._type === 'WebRtcEndpoint') {
          await videoAdapter.gatherCandidates(this.videoMediaElement);
        }

        this._updateHostLoad();

        Logger.trace("[mcs-sdp-session] Answer SDP for session", this.id, answer);
        this.emitter.emit(C.EVENT.MEDIA_CONNECTED, this.getMediaInfo());

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
        const {
          videoAdapter,
          audioAdapter,
          contentAdapter
        } = this._adapters;

        await videoAdapter.addIceCandidate(this.videoMediaElement, candidate);
        resolve();
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  _hasAvailableCodec () {
    return (this._offer.hasAvailableVideoCodec() === this._answer.hasAvailableVideoCodec()) &&
      (this._offer.hasAvailableAudioCodec() === this._answer.hasAvailableAudioCodec());
  }


  _updateHostLoad () {
    if (this._answer.hasAvailableVideoCodec()) {
      this.balancer.incrementHostStreams(this.videoHost.id, 'video');
      this.hasVideo = true;
    }

    if (this._answer.hasAvailableAudioCodec()) {
      this.balancer.incrementHostStreams(this.audioHost.id, 'audio');
      this.hasAudio = true;
    }
  }
}
