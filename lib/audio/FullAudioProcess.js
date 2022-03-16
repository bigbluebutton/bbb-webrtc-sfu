'use strict';

const AudioReqHdlr = require('./audio-req-hdlr.js');
const BaseProcess = require('../common/base-process.js');
const C = require('../bbb/messages/Constants');

const AUDIO_PROCESS_PREFIX = '[audio-process]';
const AUDIO_REQ_HDLR_PREFIX = '[audio-req-hdlr]';

const manager = new AudioReqHdlr(
  C.TO_AUDIO,
  [C.FROM_AKKA_APPS, C.TO_SFU],
  AUDIO_REQ_HDLR_PREFIX,
);
const newProcess = new BaseProcess(manager, AUDIO_PROCESS_PREFIX);

newProcess.start();
