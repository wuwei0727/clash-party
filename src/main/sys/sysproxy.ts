import { promisify } from 'util'
import { exec, execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getAutoProxy, getSystemProxy, triggerAutoProxy, triggerManualProxy } from 'sysproxy-rs'
import { net } from 'electron'
import axios from 'axios'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import { pacPort, startPacServer, stopPacServer } from '../resolve/server'
import { proxyLogger } from '../utils/logger'
import { resourcesFilesDir } from '../utils/dirs'

let triggerSysProxyTimer: NodeJS.Timeout | null = null
let triggerSysProxyQueue: Promise<void> = Promise.resolve()
let triggerSysProxyGeneration = 0
const helperSocketPath = '/tmp/mihomo-party-helper.sock'
const helperPath = '/Library/PrivilegedHelperTools/party.mihomo.helper'
const helperPlistPath = '/Library/LaunchDaemons/party.mihomo.helper.plist'
const helperService = 'system/party.mihomo.helper'

const defaultBypass: string[] = (() => {
  switch (process.platform) {
    case 'linux':
      return ['localhost', '127.0.0.1', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '::1']
    case 'darwin':
      return [
        '127.0.0.1',
        '192.168.0.0/16',
        '10.0.0.0/8',
        '172.16.0.0/12',
        'localhost',
        '*.local',
        '*.crashlytics.com',
        '<local>'
      ]
    case 'win32':
      return [
        'localhost',
        '127.*',
        '192.168.*',
        '10.*',
        '172.16.*',
        '172.17.*',
        '172.18.*',
        '172.19.*',
        '172.20.*',
        '172.21.*',
        '172.22.*',
        '172.23.*',
        '172.24.*',
        '172.25.*',
        '172.26.*',
        '172.27.*',
        '172.28.*',
        '172.29.*',
        '172.30.*',
        '172.31.*',
        '<local>'
      ]
    default:
      return ['localhost', '127.0.0.1', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '::1']
  }
})()

interface TriggerSysProxyOptions {
  helperTimeout?: number
  force?: boolean
}

function helperAxiosOptions(helperTimeout?: number): { socketPath: string; timeout?: number } {
  return helperTimeout === undefined
    ? { socketPath: helperSocketPath }
    : { socketPath: helperSocketPath, timeout: helperTimeout }
}

function beginSysProxyRequest(): number {
  triggerSysProxyGeneration += 1
  if (triggerSysProxyTimer) {
    clearTimeout(triggerSysProxyTimer)
    triggerSysProxyTimer = null
  }
  return triggerSysProxyGeneration
}

function isCurrentSysProxyRequest(generation: number): boolean {
  return generation === triggerSysProxyGeneration
}

function enqueueSysProxyOperation<T>(operation: () => Promise<T>): Promise<T> {
  const queuedOperation = triggerSysProxyQueue.then(operation, operation)
  // Keep later system-proxy operations running after a failed operation.
  triggerSysProxyQueue = queuedOperation.then(
    () => undefined,
    () => undefined
  )
  return queuedOperation
}

async function waitForLatestSysProxyQueue(): Promise<void> {
  while (true) {
    const queue = triggerSysProxyQueue
    await queue
    if (queue === triggerSysProxyQueue) return
  }
}

function cloneSysProxyConfig(config: ISysProxyConfig): ISysProxyConfig {
  return {
    ...config,
    bypass: config.bypass ? [...config.bypass] : undefined
  }
}

function readNativeSysProxyEnabled(): boolean | null {
  try {
    const manualProxy = getSystemProxy()
    const autoProxy = getAutoProxy()
    return manualProxy.enable || autoProxy.enable
  } catch {
    return null
  }
}

async function syncConfigToNativeSysProxy(): Promise<void> {
  const nativeEnabled = readNativeSysProxyEnabled()
  if (nativeEnabled === null) return

  try {
    await patchAppConfig({ sysProxy: { enable: nativeEnabled } })
  } catch (error) {
    await proxyLogger.warn('Failed to synchronize system proxy config with native state', error)
  }
}

function verifyNativeSysProxyState(enable: boolean, generation: number): void {
  if (!isCurrentSysProxyRequest(generation)) return

  const nativeEnabled = readNativeSysProxyEnabled()
  if (nativeEnabled !== null && nativeEnabled !== enable) {
    throw new Error('Native system proxy state did not match the requested state')
  }
}

async function rollbackSysProxyState(
  previousConfig: ISysProxyConfig,
  generation: number,
  restoreNativeState: boolean
): Promise<void> {
  const restoreConfig = async (): Promise<boolean> => {
    if (!isCurrentSysProxyRequest(generation)) return false

    try {
      await patchAppConfig({ sysProxy: previousConfig })
      return isCurrentSysProxyRequest(generation)
    } catch (error) {
      await proxyLogger.warn('Failed to rollback system proxy config', error)
      return false
    }
  }

  let configRestored = await restoreConfig()
  let nativeRestored = !restoreNativeState

  if (restoreNativeState && configRestored && isCurrentSysProxyRequest(generation)) {
    try {
      await triggerSysProxyInternal(previousConfig.enable, generation)
      if (!isCurrentSysProxyRequest(generation)) return
      nativeRestored = true
    } catch (error) {
      await proxyLogger.warn('Failed to rollback native system proxy state', error)
    }
  }

  if ((!configRestored || !nativeRestored) && isCurrentSysProxyRequest(generation)) {
    if (!configRestored) {
      configRestored = await restoreConfig()
    }

    if (
      restoreNativeState &&
      configRestored &&
      !nativeRestored &&
      isCurrentSysProxyRequest(generation)
    ) {
      try {
        await triggerSysProxyInternal(previousConfig.enable, generation)
        if (!isCurrentSysProxyRequest(generation)) return
        nativeRestored = true
      } catch (error) {
        await proxyLogger.warn('Failed to retry native system proxy rollback', error)
      }
    }
  }

  if ((!configRestored || !nativeRestored) && isCurrentSysProxyRequest(generation)) {
    await proxyLogger.warn('System proxy rollback remained incomplete; synchronizing enable state')
    await syncConfigToNativeSysProxy()
  }
}

export async function triggerSysProxy(
  enable: boolean,
  options: TriggerSysProxyOptions = {}
): Promise<void> {
  const generation = beginSysProxyRequest()
  await enqueueSysProxyOperation(async () => {
    try {
      await triggerSysProxyInternal(enable, generation, options)
    } catch (error) {
      if (isCurrentSysProxyRequest(generation)) {
        await syncConfigToNativeSysProxy()
      }
      throw error
    }
  })
}

export async function setSysProxyEnabled(enable: boolean): Promise<boolean> {
  const generation = beginSysProxyRequest()

  const applied = await enqueueSysProxyOperation(async () => {
    if (!isCurrentSysProxyRequest(generation)) return false

    const currentConfig = await getAppConfig()
    const previousConfig = cloneSysProxyConfig(currentConfig.sysProxy)
    let nativeStateAttempted = false

    try {
      await patchAppConfig({ sysProxy: { enable } })
      if (!isCurrentSysProxyRequest(generation)) return false

      nativeStateAttempted = true
      await triggerSysProxyInternal(enable, generation)
      if (!isCurrentSysProxyRequest(generation)) return false
      return true
    } catch (error) {
      // A newer request owns the final state and will apply its own target.
      if (!isCurrentSysProxyRequest(generation)) return false

      await rollbackSysProxyState(previousConfig, generation, nativeStateAttempted)
      throw error
    }
  })

  if (!applied) await waitForLatestSysProxyQueue()
  return applied
}

export async function patchSysProxyConfig(patch: Partial<ISysProxyConfig>): Promise<boolean> {
  const generation = beginSysProxyRequest()

  const applied = await enqueueSysProxyOperation(async () => {
    if (!isCurrentSysProxyRequest(generation)) return false

    const currentConfig = await getAppConfig()
    const previousConfig = cloneSysProxyConfig(currentConfig.sysProxy)
    const nextSysProxy: ISysProxyConfig = {
      ...currentConfig.sysProxy,
      ...patch,
      enable: currentConfig.sysProxy.enable
    }

    try {
      await patchAppConfig({ sysProxy: nextSysProxy })
      if (!isCurrentSysProxyRequest(generation)) return false

      await triggerSysProxyInternal(nextSysProxy.enable, generation)
      return isCurrentSysProxyRequest(generation)
    } catch (error) {
      // A concurrent enable/disable request will apply the newest target and parameters.
      if (!isCurrentSysProxyRequest(generation)) return false

      await rollbackSysProxyState(previousConfig, generation, true)
      throw error
    }
  })

  if (!applied) await waitForLatestSysProxyQueue()
  return applied
}

async function triggerSysProxyInternal(
  enable: boolean,
  generation: number,
  options: TriggerSysProxyOptions = {}
): Promise<void> {
  if (!isCurrentSysProxyRequest(generation)) return

  if (net.isOnline() || options.force) {
    if (enable) {
      await disableSysProxy(options.helperTimeout)
      if (!isCurrentSysProxyRequest(generation)) return
      await enableSysProxy(options.helperTimeout)
    } else {
      await disableSysProxy(options.helperTimeout)
    }

    if (!isCurrentSysProxyRequest(generation)) return
    verifyNativeSysProxyState(enable, generation)
  } else {
    if (triggerSysProxyTimer) clearTimeout(triggerSysProxyTimer)
    triggerSysProxyTimer = setTimeout(() => {
      triggerSysProxyTimer = null
      if (!isCurrentSysProxyRequest(generation)) return
      void triggerSysProxy(enable, options).catch((error) => {
        void proxyLogger.warn('Failed to retry system proxy operation', error)
      })
    }, 5000)
  }
}

async function enableSysProxy(helperTimeout?: number): Promise<void> {
  await startPacServer()
  const { sysProxy } = await getAppConfig()
  const { mode, host, bypass = defaultBypass } = sysProxy
  const { 'mixed-port': port = DEFAULT_MIHOMO_PORTS.mixed } = await getControledMihomoConfig()
  const proxyHost = host || '127.0.0.1'
  const formattedBypass = bypass
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(process.platform === 'win32' ? ';' : ',')

  if (process.platform === 'darwin') {
    // macOS 需要 helper 提权
    if (mode === 'auto') {
      await helperRequest(() =>
        axios.post(
          'http://localhost/pac',
          { url: `http://${proxyHost}:${pacPort}/pac` },
          helperAxiosOptions(helperTimeout)
        )
      )
    } else {
      await helperRequest(() =>
        axios.post(
          'http://localhost/global',
          { host: proxyHost, port: port.toString(), bypass: formattedBypass },
          helperAxiosOptions(helperTimeout)
        )
      )
    }
  } else {
    // Windows / Linux 直接使用 sysproxy-rs
    try {
      if (mode === 'auto') {
        triggerAutoProxy(true, `http://${proxyHost}:${pacPort}/pac`)
      } else {
        triggerManualProxy(true, proxyHost, port, formattedBypass)
      }
    } catch (error) {
      await proxyLogger.error('Failed to enable system proxy', error)
      throw error
    }
  }
}

async function disableSysProxy(helperTimeout?: number): Promise<void> {
  await stopPacServer()

  if (process.platform === 'darwin') {
    await helperRequest(
      () => axios.get('http://localhost/off', helperAxiosOptions(helperTimeout)),
      helperTimeout === undefined ? 2 : 0
    )
  } else {
    // Windows / Linux 直接使用 sysproxy-rs
    try {
      triggerAutoProxy(false, '')
      triggerManualProxy(false, '', 0, '')
    } catch (error) {
      await proxyLogger.error('Failed to disable system proxy', error)
      throw error
    }
  }
}

export function disableSysProxySync(): void {
  if (process.platform === 'darwin') return
  try {
    triggerAutoProxy(false, '')
    triggerManualProxy(false, '', 0, '')
  } catch {
    // ignore errors during sync disable
  }
}

function isSocketFileExists(): boolean {
  try {
    return fs.existsSync(helperSocketPath)
  } catch {
    return false
  }
}

async function isHelperRunning(): Promise<boolean> {
  try {
    const execPromise = promisify(exec)
    const { stdout } = await execPromise('pgrep -f party.mihomo.helper')
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function isHelperServiceRegistered(): Promise<boolean> {
  try {
    const execPromise = promisify(exec)
    await execPromise(`/bin/launchctl print ${helperService}`)
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  const escaped = value.replace(/'/g, "'\"'\"'")
  return `'${escaped}'`
}

async function startHelperService(forceRepair = false): Promise<void> {
  const sourceHelper = shellQuote(path.join(resourcesFilesDir(), 'party.mihomo.helper'))
  const sourcePlist = shellQuote(path.join(resourcesFilesDir(), 'party.mihomo.helper.plist'))
  const installedHelper = shellQuote(helperPath)
  const installedPlist = shellQuote(helperPlistPath)
  const shell =
    `if ${forceRepair ? 'true' : 'false'} || [ ! -x ${installedHelper} ] || [ ! -f ${installedPlist} ] || ! /bin/launchctl print ${helperService} >/dev/null 2>&1; then ` +
    `[ -f ${sourceHelper} ] && [ -f ${sourcePlist} ] || exit 1; ` +
    `/bin/launchctl bootout ${helperService} >/dev/null 2>&1 || true; ` +
    `/bin/mkdir -p /Library/PrivilegedHelperTools /Library/LaunchDaemons; ` +
    `/bin/rm -f ${shellQuote(helperSocketPath)}; ` +
    `/usr/bin/install -o root -g wheel -m 544 ${sourceHelper} ${installedHelper}; ` +
    `/usr/bin/install -o root -g wheel -m 644 ${sourcePlist} ${installedPlist}; ` +
    `/bin/launchctl enable ${helperService} >/dev/null 2>&1 || true; ` +
    `/bin/launchctl bootstrap system ${installedPlist}; ` +
    `else /bin/launchctl kickstart -k ${helperService}; fi`
  const command = `do shell script ${JSON.stringify(shell)} with administrator privileges`
  const execFilePromise = promisify(execFile)
  await execFilePromise('/usr/bin/osascript', ['-e', command])
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

async function requestSocketRecreation(): Promise<void> {
  try {
    const execPromise = promisify(exec)
    const shell = `pkill -USR1 -f party.mihomo.helper`
    const command = `do shell script "${shell}" with administrator privileges`
    await execPromise(`osascript -e '${command}'`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  } catch (error) {
    await proxyLogger.error('Failed to send signal to helper', error)
    throw error
  }
}

async function helperRequest(requestFn: () => Promise<unknown>, maxRetries = 2): Promise<unknown> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn()
    } catch (error) {
      lastError = error as Error
      const errCode = (error as NodeJS.ErrnoException).code
      const errMsg = (error as Error).message || ''

      if (
        attempt < maxRetries &&
        (errCode === 'ECONNREFUSED' ||
          errCode === 'ENOENT' ||
          errMsg.includes('connect ECONNREFUSED') ||
          errMsg.includes('ENOENT'))
      ) {
        await proxyLogger.info(
          `Helper request failed (attempt ${attempt + 1}/${maxRetries + 1}), checking helper status...`
        )

        const helperRunning = await isHelperRunning()
        const helperRegistered = await isHelperServiceRegistered()
        const socketExists = isSocketFileExists()

        if (!helperRunning || !helperRegistered || !fs.existsSync(helperPlistPath)) {
          await proxyLogger.info('Helper service unavailable, repairing...')
          try {
            await startHelperService(!helperRunning)
            await proxyLogger.info('Helper service started, retrying...')
            continue
          } catch (startError) {
            await proxyLogger.warn('Failed to start helper service', startError)
          }
        } else if (!socketExists) {
          await proxyLogger.info('Socket file missing but helper running, requesting recreation...')
          try {
            await requestSocketRecreation()
            await proxyLogger.info('Socket recreation requested, retrying...')
            continue
          } catch (signalError) {
            await proxyLogger.warn('Failed to request socket recreation', signalError)
          }
        } else {
          await proxyLogger.info('Helper socket is unresponsive, restarting service...')
          try {
            await startHelperService()
            await proxyLogger.info('Helper service restarted, retrying...')
            continue
          } catch (restartError) {
            await proxyLogger.warn('Failed to restart helper service', restartError)
          }
        }
      }

      if (attempt === maxRetries) {
        throw lastError
      }
    }
  }

  throw lastError
}
