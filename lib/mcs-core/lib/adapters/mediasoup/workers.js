'use strict';

const os = require('os')
const mediasoup = require('mediasoup');
const { v4: uuidv4 }= require('uuid');
const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const {
  DEFAULT_NOF_WORKERS, WORKER_SETTINGS, LOG_PREFIX,
  WORKER_EXPORT_RESOURCE_USAGE,
} = require('./configs.js');
const {
  PrometheusAgent, MS_METRIC_NAMES, exportWorkerResourceUsageMetrics
} = require('./prom-metrics.js');

const CORE_COUNT = os.cpus().length
// WORKER_STORAGE: [<worker>]. Registers mediasoup workers, raw form
const WORKER_STORAGE = [];

const _resourceUsageCollector = () => {
  let workerMetricsArray = [];
  return Promise.all(
    WORKER_STORAGE.map(async worker => {
      try {
        const workerResourceUsage = await worker.getResourceUsage();
        workerMetricsArray.push(workerResourceUsage);
      } catch (error) {
        Logger.debug(LOG_PREFIX, 'Failure collecting worker resource metrics', {
          errorMessage: error.message, workerId: worker.internalAdapterId,
          workerPID: worker.pid,
        });
      }
    })
  ).then(() => {
    const sum = {};
    workerMetricsArray.forEach((workerResourceUsage) => {
      Object.entries(workerResourceUsage).forEach(([key, val]) => {
        sum[key] = val + (sum[key] || 0);
      });
    });

    return sum;
  });
};

const _replaceWorker = (oldWorkerId, replacementReason) => {
  stopWorker(oldWorkerId);
  deleteWorker(oldWorkerId);

  createWorker().then(worker => {
    Logger.info(LOG_PREFIX, 'New replacement worker up', {
      oldWorkerId, workerId: worker.internalAdapterId, workerPID: worker.pid,
      replacementReason,
    });
  }).catch(error => {
    Logger.error(LOG_PREFIX, 'CRITICAL: Worker replacement failed',
      { errorMessage: error.message, replacementReason });
  });
}

const _trackWorkerDeathEvent = (worker) => {
  worker.once('died', (error) => {
    Logger.error(LOG_PREFIX, 'Worker died', {
      errorMessage: error.message, workerId: worker.internalAdapterId,
      workerPID: worker.pid,
    });

    PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_WORKER_CRASHES);
    _replaceWorker(worker.internalAdapterId, 'died');
  });
};

const _getNofWorkersFromStrat = (workerStrat) => {
  if (typeof workerStrat === 'string' && workerStrat === 'auto') {
    return CORE_COUNT;
  } else if (typeof workerStrat === 'number') {
    return workerStrat;
  }

  // 8w
  return DEFAULT_NOF_WORKERS;
};

const storeWorker = (worker) => {
  if (!worker) return false;

  if (hasWorker(worker.internalAdapterId)) {
    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_WORKER_COLLISION"
    });
  }

  WORKER_STORAGE.push(worker);
  PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_WORKERS);

  return true;
}

const getWorker = (workerId) => {
  return WORKER_STORAGE.find(worker => worker.internalAdapterId === workerId);
}

const hasWorker = (workerId) => {
  return WORKER_STORAGE.some(worker => worker.internalAdapterId === workerId);
}

// Round-robin
const getWorkerRR = () => {
  const worker = WORKER_STORAGE.shift();
  if (worker) {
    WORKER_STORAGE.push(worker);
  }
  return worker;
}

const deleteWorker = (workerId) => {
  let deleted = false;
  let i = 0;

  while (i < WORKER_STORAGE.length || !deleted) {
    if (WORKER_STORAGE[i].internalAdapterId === workerId) {
      WORKER_STORAGE.splice(i, 1);
      deleted = true;
    } else {
      i++;
    }
  }

  if (deleted) {
    PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_WORKERS);
  }

  return deleted;
}


const createWorkers = (
  workerStrat,
  workerSettings,
) => {
  const nofWorkers = _getNofWorkersFromStrat(workerStrat);
  Logger.info(LOG_PREFIX, `Spawning workers: ${nofWorkers} (${workerStrat})`);

  for (let i = 0; i < nofWorkers; i++) {
    createWorker(workerSettings).catch(error => {
      Logger.error(LOG_PREFIX, 'Worker creation failed',
        { errorMessage: error.message, errorCode: error.code });
    });
  }

  if (WORKER_EXPORT_RESOURCE_USAGE) {
    exportWorkerResourceUsageMetrics(_resourceUsageCollector);
  }
}

const createWorker = async (workerSettings = WORKER_SETTINGS) => {
  const worker = await mediasoup.createWorker(workerSettings)

  worker.internalAdapterId = uuidv4();
  _trackWorkerDeathEvent(worker);
  storeWorker(worker);
  Logger.info(LOG_PREFIX, 'New worker created', {
    workerId: worker.internalAdapterId, workerPID: worker.pid,
  });

  return worker;
}

const stopWorker = (workerId) => {
  const worker = getWorker(workerId);

  if (worker && !worker.closed) {
    worker.close();
  }
}

module.exports = {
  WORKER_STORAGE,
  createWorkers,
  createWorker,
  stopWorker,
  getWorker,
  getWorkerRR,
  deleteWorker,
};
