import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { lock, unlock } from "proper-lockfile";

export interface DataRootLockHandle {
  release(): Promise<void>;
}

export async function acquireDataRootLock(
  dataRoot: string,
  lockFilePath: string,
): Promise<DataRootLockHandle> {
  mkdirSync(dirname(lockFilePath), { recursive: true });
  const release = await lock(dataRoot, {
    lockfilePath: lockFilePath,
    realpath: false,
    stale: 30000,
    update: 10000,
    retries: {
      retries: 0,
      factor: 1,
      minTimeout: 10,
      maxTimeout: 10,
      randomize: false,
    },
  });
  return {
    async release() {
      await release();
    },
  };
}

export async function releaseDataRootLock(dataRoot: string, lockFilePath: string): Promise<void> {
  await unlock(dataRoot, { lockfilePath: lockFilePath, realpath: false });
}
