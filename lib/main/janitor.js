const config = require('config');
const RedisGateway = (new (require('../bbb/pubsub/bbb-gw')));
const MCSAgent = require('./mcs-agent.js');
const Logger = require('../common/logger.js');

const { TO_VOICE_CONF } = require('../bbb/messages/Constants');
const DESTROY_ROOM_ON_EJECT = config.has('destroyRoomOnEject')
  ? config.get('destroyRoomOnEject')
  : false;
const EJECT_ALL_FROM_VOICE_CONF = 'EjectAllFromVoiceConfMsg';

const _destroyRoomOnEjectAllFromVoiceConf = () => {
  if (!DESTROY_ROOM_ON_EJECT) return;

  RedisGateway.on(EJECT_ALL_FROM_VOICE_CONF, ({ body }) => {
    const { voiceConf } = body;

    if (voiceConf) {
      MCSAgent.destroyRoom(voiceConf).then(() => {
        Logger.info('Janitor: requested room destruction on EjectAllFromVoiceConfMsg', {
          voiceConf,
        });
      }).catch(error => {
        Logger.error('Janitor: Room destruction on EjectAllFromVoiceConfMsg failed', {
          voiceConf, errorMessage: error.message, errorCode: error.code,
        });
      });
    }
  });
};


const clockIn = () => {
  RedisGateway.addSubscribeChannel(TO_VOICE_CONF);
  _destroyRoomOnEjectAllFromVoiceConf();
};


module.exports = {
  clockIn,
}
