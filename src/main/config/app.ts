import { readFile } from 'fs/promises'
import { appConfigPath } from '../utils/dirs'
import { atomicWriteFile, WriteQueue } from '../utils/safeFile'
import { parse, stringify } from '../utils/yaml'
import { deepMerge } from '../utils/merge'
import { defaultConfig } from '../utils/template'
import {
  normalizeMaxLogFileSizeMB,
  setCoreLogDisabled,
  setGlobalMaxLogFileSizeMB
} from '../utils/logFile'
import { setAppLogDisabled } from '../utils/logger'

let appConfig: IAppConfig // config.yaml
const appConfigWriteQueue = new WriteQueue()

function cloneDefaultConfig(): IAppConfig {
  return JSON.parse(JSON.stringify(defaultConfig)) as IAppConfig
}

function cloneAppConfig(config: IAppConfig): IAppConfig {
  return JSON.parse(JSON.stringify(config)) as IAppConfig
}

export async function getAppConfig(force = false): Promise<IAppConfig> {
  if (force || !appConfig) {
    await appConfigWriteQueue.run(async () => {
      const data = await readFile(appConfigPath(), 'utf-8')
      const parsedConfig = parse(data)
      const mergedConfig = deepMerge(cloneDefaultConfig(), parsedConfig || {})
      mergedConfig.maxLogFileSize = normalizeMaxLogFileSizeMB(mergedConfig.maxLogFileSize)
      if (JSON.stringify(mergedConfig) !== JSON.stringify(parsedConfig)) {
        await atomicWriteFile(appConfigPath(), stringify(mergedConfig))
      }
      setGlobalMaxLogFileSizeMB(mergedConfig.maxLogFileSize)
      setCoreLogDisabled(mergedConfig.disableCoreLog === true)
      setAppLogDisabled(mergedConfig.disableAppLog === true)
      appConfig = mergedConfig
    })
  }
  if (typeof appConfig !== 'object') appConfig = cloneDefaultConfig()
  return appConfig
}

export async function patchAppConfig(patch: Partial<IAppConfig>): Promise<void> {
  await appConfigWriteQueue.run(async () => {
    if (typeof appConfig !== 'object') {
      const data = await readFile(appConfigPath(), 'utf-8')
      appConfig = deepMerge(cloneDefaultConfig(), parse(data) || {})
    }

    const previousConfig = cloneAppConfig(appConfig)
    const replaceNameserverPolicy = Object.prototype.hasOwnProperty.call(patch, 'nameserverPolicy')
    const nextConfig = deepMerge(
      cloneAppConfig(appConfig),
      patch
    )
    if (replaceNameserverPolicy) {
      nextConfig.nameserverPolicy = patch.nameserverPolicy ?? {}
    }
    nextConfig.maxLogFileSize = normalizeMaxLogFileSizeMB(nextConfig.maxLogFileSize)
    try {
      await atomicWriteFile(appConfigPath(), stringify(nextConfig))
      appConfig = nextConfig
      setGlobalMaxLogFileSizeMB(nextConfig.maxLogFileSize)
      setCoreLogDisabled(nextConfig.disableCoreLog === true)
      setAppLogDisabled(nextConfig.disableAppLog === true)
    } catch (error) {
      appConfig = previousConfig
      throw error
    }
  })
}
