'use strict';

const mediasoup = require('mediasoup');
const { v4: uuidv4 }= require('uuid');
const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const {
  WORKER_SETTINGS, WORKER_EXPORT_RESOURCE_USAGE,
} = require('./configs.js');
const {
  PrometheusAgent, MS_METRIC_NAMES, exportWorkerResourceUsageMetrics
} = require('./prom-metrics.js');

const SHARED_POOL_ID = 'shared';

// WORKER_STORAGE: each key has a val in the form of [<worker>].
const WORKER_STORAGE = {
  [SHARED_POOL_ID]: [],
}

const _getAllWorkers = () => {
  return Object.values(WORKER_STORAGE).reduce((allWorkers, partialWorkers) => {
    return [...allWorkers, ...partialWorkers];
  }, []);
}

const _resourceUsageCollector = () => {
  let workerMetricsArray = [];
  return Promise.all(
    _getAllWorkers.map(async worker => {
      try {
        const workerResourceUsage = await worker.getResourceUsage();
        workerMetricsArray.push(workerResourceUsage);
      } catch (error) {
        Logger.debug('mediasoup: failure collecting worker resource metrics', {
          errorMessage: error.message, workerId: worker.appData.internalAdapterId,
          workerPID: worker.pid,
        });
      }
    }),
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

const _replaceWorker = (worker, replacementReason) => {
  const mediaType = worker.appData.mediaType;
  const oldWorkerId = worker.appData.internalAdapterId;
  stopWorker(worker);
  deleteWorker(worker);

  createWorker({ mediaType }).then(newWorker => {
    Logger.info('mediasoup: replacement worker up', {
      oldWorkerId,
      newWorkerId: newWorker.appData.internalAdapterId,
      workerPID: worker.pid,
      replacementReason,
    });

    storeWorker(newWorker);
  }).catch(error => {
    Logger.error('mediasoup: worker replacement failed',
      { errorMessage: error.message, replacementReason });
  });
}

const _trackWorkerDeathEvent = (worker) => {
  worker.once('died', (error) => {
    Logger.error('mediasoup: worker died', {
      errorMessage: error.message, workerId: worker.appData.internalAdapterId,
      workerPID: worker.pid,
    });

    PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_WORKER_CRASHES, {
      pool: worker.appData.mediaType || SHARED_POOL_ID,
    });

    _replaceWorker(worker, 'died');
  });
};

const storeWorker = (worker) => {
  if (worker == null) return false;
  const storage = _fetchWorkerStorage(worker.appData.mediaType);
  if (typeof storage !== 'object') return false;

  if (hasWorker(storage, worker.appData.internalAdapterId)) {
    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_WORKER_COLLISION"
    });
  }

  storage.push(worker);
  PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_WORKERS, {
    pool: worker.appData.mediaType || SHARED_POOL_ID,
  });

  return true;
}

const _fetchWorkerStorage = (mediaType) => {
  if (mediaType && mediaType !== C.MEDIA_PROFILE.ALL) {
    const tentativeStorage = WORKER_STORAGE[mediaType];
    if (tentativeStorage) return tentativeStorage;
  }

  return WORKER_STORAGE[SHARED_POOL_ID];
}

const getWorker = (workerId, mediaType) => {
  const storage = _fetchWorkerStorage(mediaType);
  return storage.find(worker => worker.appData.internalAdapterId === workerId);
}

const hasWorker = (storage, workerId) => {
  return storage.some(worker => worker.appData.internalAdapterId === workerId);
}

// Round-robin
const getWorkerRR = (mediaType) => {
  const storage = _fetchWorkerStorage(mediaType);
  const worker = storage.shift();

  if (worker) {
    storage.push(worker);
  }

  return worker;
}

const deleteWorker = (worker) => {
  const storage = _fetchWorkerStorage(worker.appData.mediaType);
  let deleted = false;
  let i = 0;

  while (i < storage.length || !deleted) {
    if (storage[i].appData.internalAdapterId === worker.appData.internalAdapterId) {
      storage.splice(i, 1);
      deleted = true;
    } else {
      i++;
    }
  }

  if (deleted) {
    PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_WORKERS, {
      pool: worker.appData.mediaType || SHARED_POOL_ID,
    });
  }

  return deleted;
}

const createWorker = async ({ workerSettings = WORKER_SETTINGS, mediaType }) => {
  const worker = await mediasoup.createWorker(workerSettings)

  worker.appData.internalAdapterId = uuidv4();
  worker.appData.mediaType = mediaType;
  _trackWorkerDeathEvent(worker);
  Logger.info('mediasoup: worker created', {
    workerId: worker.appData.internalAdapterId, workerPID: worker.pid,
    type: mediaType || SHARED_POOL_ID,
  });

  return worker;
}

const createSharedPoolWorkers = (
  sharedWorkers,
  workerSettings,
) => {
  Logger.info(`mediasoup: spawning shared pool workers (${sharedWorkers})`);

  for (let i = 0; i < sharedWorkers ; i++) {
    createWorker({ workerSettings }).then(worker => {
      storeWorker(worker);
    }).catch(error => {
      Logger.error('mediasoup: worker creation failed - shared pool',
        { errorMessage: error.message, errorCode: error.code });
    });
  }

  if (WORKER_EXPORT_RESOURCE_USAGE) {
    exportWorkerResourceUsageMetrics(_resourceUsageCollector);
  }
}

const createDedicatedMediaTypeWorkers = (
  dedicatedMediaTypeWorkers,
  workerSettings,
) => {
  for (const [mediaType, numberOfWorkers] of Object.entries(dedicatedMediaTypeWorkers)) {
    if (numberOfWorkers == '0') return;
    if (WORKER_STORAGE[mediaType] == null) WORKER_STORAGE[mediaType] = [];

    Logger.info(`mediasoup: spawning ${mediaType} workers (${numberOfWorkers})`);

    for (let i = 0; i < numberOfWorkers; i++) {
      createWorker({ workerSettings, mediaType }).then(worker => {
        storeWorker(worker);
      }).catch(error => {
        Logger.error(`mediasoup: worker creation failed - ${mediaType}`,
          { mediaType, errorMessage: error.message, errorCode: error.code });
      });
    }
  }

  if (WORKER_EXPORT_RESOURCE_USAGE) {
    exportWorkerResourceUsageMetrics(_resourceUsageCollector);
  }
}

const stopWorker = (worker) => {
  worker.close();
}

module.exports = {
  WORKER_STORAGE,
  createSharedPoolWorkers,
  createDedicatedMediaTypeWorkers,
  createWorker,
  stopWorker,
  getWorker,
  getWorkerRR,
  deleteWorker,
};
