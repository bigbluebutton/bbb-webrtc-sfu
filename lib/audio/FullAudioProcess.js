'use strict';

const AudioManager= require('./FullAudioManager');
const BaseProcess = require('../base/BaseProcess');
const C = require('../bbb/messages/Constants');

const manager = new AudioManager(
  C.TO_AUDIO,
  [C.FROM_AKKA_APPS, C.TO_SFU],
  C.AUDIO_MANAGER_PREFIX
);
const newProcess = new BaseProcess(manager, C.AUDIO_PROCESS_PREFIX);

newProcess.start();
