const errors = require('../base/errors');
const config = require('config');
const Messaging = require('../bbb/messages/Messaging');
const C = require('../bbb/messages/Constants');

const PERMISSION_PROBES = config.get('permissionProbes');

const getScreenBroadcastPermission = (
  gateway, meetingId, voiceBridge, userId, sfuSessionId
) => {
  if (!PERMISSION_PROBES) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onResp = (payload) => {
      if (meetingId === payload.meetingId
        && voiceBridge === payload.voiceConf
        && userId === payload.userId
        && payload.allowed) {
        return resolve();
      }

      return reject(errors.SFU_UNAUTHORIZED);
    }

    const msg = Messaging.generateGetScreenBroadcastPermissionReqMsg(
      meetingId,
      voiceBridge,
      userId,
      sfuSessionId
    );
    gateway.once(C.GET_SCREEN_BROADCAST_PERM_RESP_MSG+sfuSessionId, onResp);
    gateway.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
  });
}

const getScreenSubscribePermission = (
  gateway, meetingId, voiceBridge, userId, streamId, sfuSessionId
) => {
  if (!PERMISSION_PROBES) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onResp = (payload) => {
      if (meetingId === payload.meetingId
        && voiceBridge === payload.voiceConf
        && userId === payload.userId
        && payload.allowed) {
        return resolve();
      }

      return reject(errors.SFU_UNAUTHORIZED);
    }

    const msg = Messaging.generateGetScreenSubscribePermissionReqMsg(
      meetingId,
      voiceBridge,
      userId,
      streamId,
      sfuSessionId
    );

    const suffix = `${sfuSessionId}/${streamId}`;
    const enrichedEventId = `${C.GET_SCREEN_SUBSCRIBE_PERM_RESP_MSG}/${suffix}`
    gateway.once(enrichedEventId, onResp);
    gateway.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
  });
}

module.exports = {
  getScreenBroadcastPermission,
  getScreenSubscribePermission,
}
