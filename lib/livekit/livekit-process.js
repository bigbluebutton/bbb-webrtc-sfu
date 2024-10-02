'use strict';

const BaseProcess = require('../common/base-process.js');
const LiveKitController = require('./livekit-controller.js');
const C = require('../bbb/messages/Constants.js');

const controller = new LiveKitController(null, [
  C.TO_SFU,
  C.TO_VOICE_CONF,
  C.FROM_AKKA_APPS,
], 'livekit');
const newProcess = new BaseProcess(controller, 'livekit');

newProcess.start();
