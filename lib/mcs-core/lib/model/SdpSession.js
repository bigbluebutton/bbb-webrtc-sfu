/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/Constants');
const SdpWrapper = require('../utils/SdpWrapper');
const rid = require('readable-id');
const MediaSession = require('./MediaSession');
const config = require('config');
const kurentoUrl = config.get('kurentoUrl');
const kurentoIp = config.get('kurentoIp');
const Logger = require('../../../utils/Logger');

module.exports = class SdpSession extends MediaSession {
  constructor(
    emitter,
    offer = null,
    room,
    user,
    type = 'WebRtcEndpoint',
    options
  ) {
    super(emitter, room, user, type, options);
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
      this._offer = new SdpWrapper(offer, this._type);
    }
  }

  setAnswer (answer) {
    if (answer) {
      this._answer = new SdpWrapper(answer, this._type);
    }
  }

  async _defileAndProcess () {
    const videoDescription = this._offer.mainVideoSdp;
    const audioDescription = this._offer.audioSdp;
    Logger.trace('[mcs-sdp-session] Defiling this beloved SDP for session', this.id, videoDescription, audioDescription);
    const videoAnswer = await this._videoAdapter.processOffer(this.videoMediaElement,
      videoDescription, { name: this._name });
    const audioAnswer = await this._audioAdapter.processOffer(this.audioMediaElement,
      audioDescription, { name: this._name });
    Logger.trace('[mcs-sdp-session] The wizard responsible for this session', this.id, 'processed the following answers', videoAnswer, audioAnswer);
    return videoAnswer + this._offer.removeSessionDescription(audioAnswer);

  }

  process () {
    return new Promise(async (resolve, reject) => {
      try {
        let answer;

        if (this._isComposedAdapter) {
          answer = await this._defileAndProcess(this._offer);
        } else {
          let offer = this._offer ? this._offer.plainSdp : null;
          answer = await this._videoAdapter.processOffer(this.videoMediaElement,
            offer,
            { name: this._name }
          );
        }

        this.setAnswer(answer);

        Logger.trace("[mcs-sdp-session] Answer SDP for session", this.id, answer);

        // Checks if the media server was able to find a compatible media line
        if (this._offer && answer) {
          if (!this._hasAvailableCodec()) {
            return reject(this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
          }

          this._mediaTypes.video = this._answer.hasAvailableVideoCodec();
          this._mediaTypes.audio = this._answer.hasAvailableAudioCodec();
        }

        if (this._offer && this._type !== 'WebRtcEndpoint') {
          this._offer.replaceServerIpv4(kurentoIp);
        }

        if (this._type === 'WebRtcEndpoint') {
          await this._videoAdapter.gatherCandidates(this.videoMediaElement);
        }

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
        await this._videoAdapter.addIceCandidate(this.videoMediaElement, candidate);
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
}
