const config = require('config');
const errors = require('../base/errors');
const Messaging = require('../bbb/messages/Messaging');
const C = require('../bbb/messages/Constants');

const STRIP_TWCC_EXT = config.has('audioStripTwccExt')
  ? config.get('audioStripTwccExt')
  : true;
const PERMISSION_PROBES = config.get('permissionProbes');

// Strip transport-cc from mic/listen only streams for now - FREESWITCH
// doesn't support it and having it enabled on the client side seems to trip
// something up there in regards to RTP packet processing for reasons yet
// unknown - prlanzarin Mar 27 2022
const getAudioRtpHdrExts = () => {
  return (STRIP_TWCC_EXT && config.has('mediasoup.webRtcHeaderExts')) ?
    config.util.cloneDeep(config.get('mediasoup.webRtcHeaderExts')).filter(
      ({ uri } ) => uri !== 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
    ) : undefined;
}

const getGlobalAudioPermission = (
  gateway, meetingId, voiceBridge, userId, sfuSessionId
) => {
  if (!PERMISSION_PROBES) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onResp = (payload) => {
      if (meetingId === payload.meetingId
        && voiceBridge === payload.voiceConf
        && userId === payload.userId && payload.allowed) {
        return resolve();
      }

      return reject(errors.SFU_UNAUTHORIZED);
    }

    const msg = Messaging.generateGetGlobalAudioPermissionReqMsg(
      meetingId,
      voiceBridge,
      userId,
      sfuSessionId
    );
    gateway.once(C.GET_GLOBAL_AUDIO_PERM_RESP_MSG+sfuSessionId, onResp);
    gateway.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
  });
}

const getMicrophonePermission = (
  gateway, meetingId, voiceBridge, userId, callerIdNum, sfuSessionId
) => {
  if (!PERMISSION_PROBES) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onResp = (payload) => {
      if (meetingId === payload.meetingId
        && voiceBridge === payload.voiceConf
        && userId === payload.userId && payload.allowed) {
        return resolve();
      }

      return reject(errors.SFU_UNAUTHORIZED);
    }

    const msg = Messaging.generateGetMicrophonePermissionReqMsg(
      meetingId,
      voiceBridge,
      userId,
      callerIdNum,
      sfuSessionId
    );
    gateway.once(C.GET_MIC_PERM_RESP_MSG+sfuSessionId, onResp);
    gateway.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
  });
}

const isRoleValid = (role) => {
  return typeof role === 'string' && (role === 'sendrecv' || role === 'recvonly' || role === 'recv');
}

const isClientSessNumberValid = (clientSessionNumber) => {
  return typeof clientSessionNumber === 'number' && clientSessionNumber >= 0;
}

module.exports = {
  getAudioRtpHdrExts,
  getGlobalAudioPermission,
  getMicrophonePermission,
  isRoleValid,
  isClientSessNumberValid,
};
