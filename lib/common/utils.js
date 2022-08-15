const os = require('os');
const Logger = require('./logger.js');

/*
 * hrTime
 * Gets monotonic system time in milliseconds
 */
const hrTime = () => {
  let t = process.hrtime();

  return t[0]*1000 + parseInt(t[1]/1000000);
}

const addBwToSpecMainType = (spec, bitrate) => {
  spec['H264'].as_main = bitrate;
  spec['H264'].tias_main = (bitrate >>> 0) * 1000;
  spec['VP8'].as_main = bitrate;
  spec['VP8'].tias_main = (bitrate >>> 0) * 1000;
  return spec;
}

const addBwToSpecContentType = (spec, bitrate) => {
  spec['H264'].as_content = bitrate;
  spec['H264'].tias_content = (bitrate >>> 0) * 1000;
  spec['VP8'].as_content  = bitrate;
  spec['VP8'].tias_content = (bitrate >>> 0) * 1000;
  return spec;
}

const _getNormalizedPriority = (prio) => {
  if (typeof prio === 'number') return prio;
  if (typeof prio === 'string' && os.constants.priority[prio]) return os.constants.priority[prio];

  throw new TypeError('Invalid priority')
}

const setProcessPriority = (pid, prio) => {
  try {
    const normalizedPrio = _getNormalizedPriority(prio);
    os.setPriority(pid, normalizedPrio);
    return true;
  } catch (error) {
    Logger.warn(`Cannot set process priority: pid=${pid}, prio=${prio}, cause=${error.message}`);
    return false;
  }
}

module.exports = {
  hrTime,
  addBwToSpecMainType,
  addBwToSpecContentType,
  setProcessPriority,
}
