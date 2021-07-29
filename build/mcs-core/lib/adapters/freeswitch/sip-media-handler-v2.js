"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
/**
 * @fileoverview SIPMediaHandlerV2
 */
const C = require('../../constants/constants.js');
module.exports = class SIPMediaHandlerV2 {
    constructor(session, options) {
        this.session = session;
        this.options = options;
        this.reinvite = false;
    }
    // Nullish overrides to avoid borking
    isReady() { return true; }
    isSupported() { return true; }
    close() { }
    render() { }
    mute() { }
    unmute() { }
    getReferMedia() { }
    hasDescription() {
        return !!this._sdpResponse;
    }
    getDescription(onSuccess, onFailure) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                if (this._sdpResponse == null) {
                    this.answerDeferral = new Promise((resolve) => {
                        this.resolveAnswer = () => {
                            return resolve(onSuccess(this._sdpResponse));
                        };
                    });
                    this.session.once(C.EVENT.RESPONSE_SET, this.resolveAnswer.bind(this));
                    return this.answerDeferral;
                }
                else {
                    this.timeout = setTimeout(function () {
                        delete this.timeout;
                        onSuccess(this._sdpResponse);
                    }.bind(this), 0);
                }
            }
            catch (error) {
                return onFailure(error);
            }
        });
    }
    setDescription(wrapper, onSuccess, onFailure) {
        return __awaiter(this, void 0, void 0, function* () {
            let sdp;
            // Duck type because SIP.js folks were a bit ~savage with 0.7.8
            if (typeof wrapper === 'object') {
                sdp = wrapper.body;
            }
            else {
                sdp = wrapper;
            }
            try {
                if (this.reinvite === false) {
                    this.reinvite = true;
                }
                else {
                    this._sdpResponse = null;
                    this.session.emit(C.EVENT.REINVITE, sdp);
                }
                this._endpointSdp = sdp;
                this.session.emit(C.EVENT.REMOTE_SDP_RECEIVED, sdp);
                this.timeout = setTimeout(function () {
                    delete this.timeout;
                    return onSuccess(sdp);
                }.bind(this), 0);
            }
            catch (error) {
                return onFailure(error);
            }
        });
    }
    setRemoteOffer(sdp) {
        this._sdpResponse = sdp;
        this.session.emit(C.EVENT.RESPONSE_SET, sdp);
    }
    setReinviteAnswer(reinviteAnswer) {
        this.setRemoteOffer(reinviteAnswer);
    }
    getEndpointSdp() {
        return this._endpointSdp;
    }
};
