'use strict';

const VideoManager= require('./VideoManager');
const BaseProcess = require('../common/base-process.js');
const C = require('../bbb/messages/Constants');

const VIDEO_PROCESS_PREFIX = '[video-process]';

const manager = new VideoManager(C.TO_VIDEO,
  [C.FROM_AKKA_APPS, C.TO_SFU],
  C.VIDEO_MANAGER_PREFIX
);
const newProcess = new BaseProcess(manager, VIDEO_PROCESS_PREFIX);

newProcess.start();
