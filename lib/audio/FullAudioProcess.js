'use strict';

const AudioManager= require('./FullAudioManager');
const BaseProcess = require('../common/base-process.js');
const C = require('../bbb/messages/Constants');

const AUDIO_PROCESS_PREFIX = '[audio-process]';

const manager = new AudioManager(
  C.TO_AUDIO,
  [C.FROM_AKKA_APPS, C.TO_SFU],
  C.AUDIO_MANAGER_PREFIX
);
const newProcess = new BaseProcess(manager, AUDIO_PROCESS_PREFIX);

newProcess.start();
