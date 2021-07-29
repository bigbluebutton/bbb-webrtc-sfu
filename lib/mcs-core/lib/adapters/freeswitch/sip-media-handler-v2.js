"use strict";

/**
 * @fileoverview SIPMediaHandlerV2
 */

const C = require('../../constants/constants.js');

module.exports = class SIPMediaHandlerV2 {
  constructor (session, options) {
    this.session = session;
    this.options = options;
    this.reinvite = false;
  }

  // Nullish overrides to avoid borking
  isReady () { return true }
  isSupported () { return true }
  close () {}
  render () {}
  mute () {}
  unmute () {}
  getReferMedia () {}

  hasDescription () {
    return !!this._sdpResponse;
  }

  async getDescription (onSuccess, onFailure) {
    try {
      if (this._sdpResponse == null) {
        this.answerDeferral = new Promise((resolve) => {
          this.resolveAnswer = () => {
            return resolve(onSuccess(this._sdpResponse));
          }
        });

        this.session.once(C.EVENT.RESPONSE_SET, this.resolveAnswer.bind(this));
        return this.answerDeferral;
      } else {
        this.timeout = setTimeout(function () {
          delete this.timeout;
          onSuccess(this._sdpResponse);
        }.bind(this), 0);
      }
    } catch (error) {
      return onFailure(error);
    }
  }

  async setDescription (wrapper, onSuccess, onFailure) {
    let sdp;

    // Duck type because SIP.js folks were a bit ~savage with 0.7.8
    if (typeof wrapper === 'object') {
      sdp = wrapper.body;
    } else {
      sdp = wrapper;
    }

    try {
      if (this.reinvite === false) {
        this.reinvite = true;
      } else {
        this._sdpResponse = null;
        this.session.emit(C.EVENT.REINVITE, sdp);
      }

      this._endpointSdp = sdp;
      this.session.emit(C.EVENT.REMOTE_SDP_RECEIVED, sdp);

      this.timeout = setTimeout(function () {
        delete this.timeout;
        return onSuccess(sdp);
      }.bind(this), 0)
    } catch (error) {
      return onFailure(error);
    }
  }

  setRemoteOffer (sdp) {
    this._sdpResponse = sdp;
    this.session.emit(C.EVENT.RESPONSE_SET, sdp);
  }

  setReinviteAnswer (reinviteAnswer) {
    this.setRemoteOffer(reinviteAnswer);
  }

  getEndpointSdp () {
    return this._endpointSdp;
  }
}
