import { ChildProcess, execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { readFile, mkdir, rm, writeFile } from 'fs/promises'
import { promisify } from 'util'
import { setTimeout as delay } from 'timers/promises'
import path from 'path'
import os from 'os'
import { existsSync, watch, type FSWatcher as NodeFSWatcher } from 'fs'
import chokidar, { type FSWatcher as ChokidarWatcher } from 'chokidar'
import { app, dialog, ipcMain } from 'electron'
import { mainWindow } from '../window'
import {
  getAppConfig,
  getControledMihomoConfig,
  getProfileItem,
  patchControledMihomoConfig,
  manageSmartOverride
} from '../config'
import {
  dataDir,
  coreLogPath,
  mihomoCoreDir,
  mihomoCorePath,
  mihomoProfileWorkDir,
  mihomoTestDir,
  mihomoWorkConfigPath,
  mihomoWorkDir
} from '../utils/dirs'
import { uploadRuntimeConfigIfChanged } from '../resolve/gistApi'
import { startMonitor } from '../resolve/trafficMonitor'
import { ensureRuntimeFiles, safeShowErrorBox } from '../utils/init'
import { parseAgeSecretKeys } from '../utils/age'
import i18next from '../../shared/i18n'
import { managerLogger } from '../utils/logger'
import { createCoreLogWritableStream } from '../utils/logFile'
import {
  startMihomoTraffic,
  startMihomoConnections,
  startMihomoLogs,
  startMihomoMemory,
  stopMihomoConnections,
  stopMihomoTraffic,
  stopMihomoLogs,
  stopMihomoMemory,
  patchMihomoConfig,
  getAxios,
  setTunStatusOverride
} from './mihomoApi'
import { generateProfile } from './factory'
import {
  checkAdminRestartForTun as checkAdminRestartForTunWithRestart,
  checkAdminPrivileges,
  getSessionAdminStatus,
  setStopCoreBeforeAdminRestart
} from './permissions'
import {
  cleanupSocketFile,
  cleanupWindowsNamedPipes,
  validateWindowsPipeAccess,
  waitForCoreReady,
  verifyProcessOwner
} from './process'
import { setPublicDNS, recoverDNS } from './dns'

// 重新导出权限相关函数
export {
  initAdminStatus,
  getSessionAdminStatus,
  checkAdminPrivileges,
  checkMihomoCorePermissions,
  checkHighPrivilegeCore,
  grantTunPermissions,
  restartAsAdmin,
  requestTunPermissions,
  showTunPermissionDialog,
  showErrorDialog,
  checkTunPermissions,
  manualGrantCorePermition
} from './permissions'

export { getDefaultDevice } from './dns'

const execFilePromise = promisify(execFile)
const ctlParam = process.platform === 'win32' ? '-ext-ctl-pipe' : '-ext-ctl-unix'
const coreHookTimeout = 30000
const automaticRestartDelay = 750
const coreProcessNames = ['mihomo', 'mihomo-alpha', 'mihomo-smart'] as const

// 核心进程状态
interface CoreProcessWatchdog {
  process: ChildProcess
  corePid: number
}

let child: ChildProcess | null = null
let coreProcessWatchdog: CoreProcessWatchdog | null = null
let isRestarting = false
let coreOperationPhase: 'initializing' | 'ready' | 'blocked' | 'shutting-down' = 'ready'
let coreOperationTail: Promise<void> = Promise.resolve()
let pendingRestart: Promise<void> | null = null
let cancelActiveStartup: ((reason: Error) => void) | null = null
let automaticRestartController: AbortController | null = null
const tunStartupTimeoutMs = 75_000
const windowsTunSelfTestTimeoutMs = 65_000
let tunModeOperation: Promise<void> | null = null

interface TunStartupWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

let tunStartupWaiter: TunStartupWaiter | null = null

// 文件监听器
let coreWatcher: ChokidarWatcher | null = null

type CoreStartupMode = 'log' | 'post-up'

interface CoreStartupHook {
  hookDir: string
  upFile: string
  upFileName: string
  postUpCommand: string
  postDownCommand: string
}

interface CoreHookWaiter {
  promise: Promise<void>
  attachProcess: (process: ChildProcess) => void
}

export function hasCoreProcess(): boolean {
  return Boolean(child && !child.killed && child.exitCode === null && child.signalCode === null)
}

export function beginCoreInitialization(): void {
  coreOperationPhase = 'initializing'
}

export function completeCoreInitialization(canStart: boolean): void {
  if (coreOperationPhase !== 'shutting-down') {
    coreOperationPhase = canStart ? 'ready' : 'blocked'
  }
}

function ensureCoreOperationAllowed(): void {
  if (coreOperationPhase === 'initializing') {
    throw new Error('Core is still initializing')
  }
  if (coreOperationPhase === 'blocked') {
    throw new Error('Core startup is unavailable because startup safety checks did not pass')
  }
  if (coreOperationPhase === 'shutting-down') {
    throw new Error('Core startup was cancelled because the application is shutting down')
  }
}

function ensureNotShuttingDown(): void {
  if (coreOperationPhase === 'shutting-down') {
    throw new Error('Core startup was cancelled because the application is shutting down')
  }
}

function runCoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  const current = coreOperationTail.then(operation, operation)
  coreOperationTail = current.then(
    () => undefined,
    () => undefined
  )
  return current
}

function cancelAutomaticRestart(): void {
  automaticRestartController?.abort()
  automaticRestartController = null
}

function stopCoreProcessWatchdog(corePid?: number): void {
  const watchdog = coreProcessWatchdog
  if (!watchdog || (corePid !== undefined && watchdog.corePid !== corePid)) return

  coreProcessWatchdog = null
  if (watchdog.process.pid) {
    try {
      process.kill(-watchdog.process.pid, 'SIGKILL')
    } catch {
      // The watchdog has already exited.
    }
  }
  watchdog.process.stdin?.destroy()
}

function startCoreProcessWatchdog(proc: ChildProcess, detached: boolean): void {
  if (process.platform !== 'linux' || detached || !proc.pid) return

  stopCoreProcessWatchdog()

  const corePid = proc.pid
  const watchdogProcess = spawn(
    'sh',
    ['-c', 'cat >/dev/null; kill -9 "$1" 2>/dev/null', 'mihomo-core-watchdog', `${corePid}`],
    {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true
    }
  )
  coreProcessWatchdog = { process: watchdogProcess, corePid }

  const watchdogStdin = watchdogProcess.stdin as typeof watchdogProcess.stdin & {
    unref?: () => void
  }
  watchdogStdin.unref?.()
  watchdogProcess.unref()

  watchdogProcess.once('error', (error) => {
    if (coreProcessWatchdog?.process === watchdogProcess) {
      coreProcessWatchdog = null
    }
    watchdogProcess.stdin.destroy()
    managerLogger.warn('Failed to start core process watchdog', error)
  })
  watchdogProcess.once('exit', (code, signal) => {
    if (coreProcessWatchdog?.process !== watchdogProcess) return

    coreProcessWatchdog = null
    managerLogger.warn(
      `Core process watchdog exited unexpectedly, code: ${code}, signal: ${signal}`
    )
  })
}

function notifyControledMihomoConfigUpdated(): void {
  mainWindow?.webContents.send('controledMihomoConfigUpdated')
  ipcMain.emit('updateTrayMenu')
}

function getTunStartupErrorMessage(log: string): string | null {
  if (log.includes('configure tun interface: operation not permitted')) {
    return i18next.t('tun.error.tunPermissionDenied')
  }

  const match = log.match(/Start TUN listening error:\s*(.+)/)
  if (match?.[1]) {
    return `TUN start failed: ${match[1].trim()}`
  }

  return null
}

function isTunStartupReadyLog(log: string): boolean {
  return log.includes('Tun adapter listening at')
}

function clearTunStartupWaiter(): void {
  tunStartupWaiter = null
}

function resolveTunStartupWaiter(): void {
  const waiter = tunStartupWaiter
  if (!waiter) return

  clearTunStartupWaiter()
  waiter.resolve()
}

function rejectTunStartupWaiter(message: string): boolean {
  const waiter = tunStartupWaiter
  if (!waiter) return false

  clearTunStartupWaiter()
  waiter.reject(new Error(message))
  return true
}

function waitForTunStartup(): Promise<void> {
  rejectTunStartupWaiter('TUN startup check was replaced')

  let timer: NodeJS.Timeout
  return new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      rejectTunStartupWaiter('TUN start timeout: waiting for TUN adapter timed out')
    }, tunStartupTimeoutMs)

    tunStartupWaiter = {
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      }
    }
  })
}

async function restartCoreAndWaitForTun(enable: boolean): Promise<void> {
  if (!enable) {
    await restartCore()
    return
  }

  const tunStartupPromise = waitForTunStartup()
  const handledTunStartupPromise = tunStartupPromise.catch((error) => {
    throw error
  })

  try {
    await restartCore()
    await handledTunStartupPromise
  } catch (error) {
    rejectTunStartupWaiter('TUN startup was canceled')
    void handledTunStartupPromise.catch(() => {})
    throw error
  }
}

function getTunDeviceFallbackName(device: string | undefined): string | null {
  if (process.platform !== 'win32') return null

  const currentDevice = (device || 'Mihomo').trim()
  if (!currentDevice) return 'ClashPartyTun'
  if (currentDevice.toLowerCase() === 'clashpartytun') return null

  return 'ClashPartyTun'
}

function getTunStackFallbackName(stack: TunStack | undefined): TunStack | null {
  if (process.platform !== 'win32') return null

  const currentStack = stack || 'mixed'
  if (currentStack === 'gvisor') return null

  return 'gvisor'
}

function shouldRetryTunWithFallback(error: unknown): boolean {
  return process.platform === 'win32' && String(error).includes('The device is not ready for use')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function hookTouchCommand(file: string): string {
  return process.platform === 'win32' ? `type nul > ${file}` : `: > ${shellQuote(file)}`
}

function coreHookDir(): string {
  if (process.platform === 'win32' && process.env.ProgramData) {
    return path.join(process.env.ProgramData, 'mihomo-party', 'core-hooks')
  }

  return path.join(dataDir(), 'core-hooks')
}

async function createCoreStartupHook(): Promise<CoreStartupHook> {
  const runId = randomUUID()
  const hookDir = coreHookDir()

  await rm(hookDir, { recursive: true, force: true })
  await mkdir(hookDir, { recursive: true })

  const upFileName = `${runId}.up`
  const downFileName = `${runId}.down`
  const upFile = path.join(hookDir, upFileName)
  const downFile = path.join(hookDir, downFileName)

  return {
    hookDir,
    upFile,
    upFileName,
    postUpCommand: hookTouchCommand(upFile),
    postDownCommand: hookTouchCommand(downFile)
  }
}

function createCoreHookWaiter(hook: CoreStartupHook): CoreHookWaiter {
  let watcher: NodeFSWatcher | undefined
  let timer: NodeJS.Timeout | undefined
  let attachedProcess: ChildProcess | undefined
  let completed = false

  let resolvePromise: () => void
  let rejectPromise: (reason?: unknown) => void

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (watcher) {
      watcher.close()
      watcher = undefined
    }
    if (attachedProcess) {
      attachedProcess.off('close', handleClose)
      attachedProcess = undefined
    }
  }

  const complete = (error?: unknown): void => {
    if (completed) return
    completed = true
    cleanup()
    if (error) {
      rejectPromise(error)
    } else {
      resolvePromise()
    }
  }

  const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    complete(new Error(`Core startup failed before post-up, code: ${code}, signal: ${signal}`))
  }

  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject

    watcher = watch(hook.hookDir, (_eventType, filename) => {
      const changedFile = filename?.toString()
      if (changedFile === hook.upFileName || (!changedFile && existsSync(hook.upFile))) {
        complete()
      }
    })

    watcher.on('error', complete)

    timer = setTimeout(() => {
      complete(new Error(`Timed out waiting for core post-up: ${coreHookTimeout}ms`))
    }, coreHookTimeout)
  })

  return {
    promise,
    attachProcess: (process) => {
      attachedProcess = process
      attachedProcess.once('close', handleClose)
    }
  }
}

async function stopPidFileCore(): Promise<void> {
  const pidPath = path.join(dataDir(), 'core.pid')
  if (!existsSync(pidPath)) return

  const pidString = await readFile(pidPath, 'utf-8').catch(() => '')
  const pid = parseInt(pidString.trim())
  if (!isNaN(pid)) {
    try {
      if (await verifyProcessOwner(pid, coreProcessNames)) {
        process.kill(pid, 'SIGINT')
        const deadline = Date.now() + 500
        let stillRunning = true
        while (stillRunning && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          try {
            process.kill(pid, 0)
          } catch {
            stillRunning = false
          }
        }
        if (stillRunning) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // ignore
          }
        }
      } else {
        managerLogger.info(`PID ${pid} is not a known mihomo process, skipping kill`)
      }
    } catch {
      // ignore
    }
  }

  await rm(pidPath).catch(() => {})
}

function parseWindowsProblemNetDevices(output: string): IWindowsTunProblemDevice[] {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const description =
        block.match(/(?:Device Description|设备描述):\s*(.+)/i)?.[1]?.trim() || 'Unknown'
      const instanceId = block.match(/(?:Instance ID|实例\s*ID):\s*(.+)/i)?.[1]?.trim() || ''
      const problem = block.match(/(?:Problem Code|问题代码):\s*(.+)/i)?.[1]?.trim() || 'Unknown'

      return { description, instanceId, problem }
    })
    .filter((device) => device.instanceId.length > 0)
}

function isWindowsWintunDevice(device: IWindowsTunProblemDevice): boolean {
  return /SWD\\Wintun\\/i.test(device.instanceId) || /wintun/i.test(device.description)
}

function isTunRelevantWindowsNetworkProblemDevice(device: IWindowsTunProblemDevice): boolean {
  return (
    /ROOT\\VMS_VSMP\\/i.test(device.instanceId) ||
    /Hyper-V.*Virtual Switch/i.test(device.description)
  )
}

function formatWindowsProblemDevices(devices: IWindowsTunProblemDevice[]): string {
  return devices
    .map(
      (device) => `${device.description} | Problem Code: ${device.problem} | ${device.instanceId}`
    )
    .join('; ')
}

function formatWindowsTunSelfTest(selfTest: IWindowsTunSelfTestResult): string {
  const details = [`TUN 自检：${selfTest.message}`]
  if (selfTest.error) {
    details.push(`错误：${selfTest.error}`)
  }
  if (selfTest.requiresRestart) {
    details.push('需要重启 Windows 后再验证。')
  }
  if (selfTest.logs.length) {
    details.push(`关键日志：${selfTest.logs.join(' | ')}`)
  }

  return details.join('\n')
}

function formatWindowsTunDiagnostics(diagnostics: IWindowsTunDiagnostics): string {
  const details: string[] = []

  if (diagnostics.problemDevices.length) {
    details.push(`异常 Wintun 设备：${formatWindowsProblemDevices(diagnostics.problemDevices)}`)
  }

  if (diagnostics.networkProblemDevices.length) {
    details.push(
      `相关 Windows 网络设备异常：${formatWindowsProblemDevices(diagnostics.networkProblemDevices)}`
    )
  }

  if (diagnostics.runningServices.length) {
    details.push(`正在运行的相关服务：${diagnostics.runningServices.join(', ')}`)
  }

  if (diagnostics.selfTest && diagnostics.selfTest.status !== 'passed') {
    details.push(formatWindowsTunSelfTest(diagnostics.selfTest))
  }

  if (!diagnostics.isAdmin) {
    details.push('当前不是管理员权限，修复时会弹出 UAC 提权窗口。')
  }

  return details.join('\n')
}

function hasBlockingWindowsTunDiagnostics(diagnostics: IWindowsTunDiagnostics): boolean {
  return (
    diagnostics.problemDevices.length > 0 ||
    diagnostics.networkProblemDevices.length > 0 ||
    diagnostics.selfTest?.status === 'failed' ||
    diagnostics.selfTest?.status === 'skipped'
  )
}

async function getWindowsProblemNetDevices(): Promise<IWindowsTunProblemDevice[]> {
  if (process.platform !== 'win32') return []

  const { stdout } = (await execFilePromise('pnputil.exe', [
    '/enum-devices',
    '/class',
    'Net',
    '/problem'
  ])) as { stdout: string }

  return parseWindowsProblemNetDevices(stdout)
}

async function getRunningWindowsTunServices(): Promise<string[]> {
  if (process.platform !== 'win32') return []

  try {
    const { stdout } = (await execFilePromise('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-Service -Name EasyTier,EasyTier-Core -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | Select-Object -ExpandProperty Name"
    ])) as { stdout: string }

    return stdout
      .split(/\r?\n/)
      .map((service) => service.trim())
      .filter(Boolean)
  } catch (error) {
    managerLogger.warn('Failed to check Windows TUN services', error)
    return []
  }
}

function randomWindowsTunSelfTestPort(offset: number): number {
  return 25000 + offset + Math.floor(Math.random() * 15000)
}

function createWindowsTunSelfTestConfig(device: string): string {
  const mixedPort = randomWindowsTunSelfTestPort(0)
  const dnsPort = randomWindowsTunSelfTestPort(20000)

  return [
    `mixed-port: ${mixedPort}`,
    'allow-lan: false',
    'mode: rule',
    'log-level: debug',
    'external-controller: 127.0.0.1:0',
    'tun:',
    '  enable: true',
    '  stack: gvisor',
    `  device: ${device}`,
    '  auto-route: false',
    '  auto-detect-interface: false',
    '  dns-hijack:',
    '    - any:53',
    'dns:',
    '  enable: true',
    `  listen: 127.0.0.1:${dnsPort}`,
    '  nameserver:',
    '    - 223.5.5.5',
    'proxies: []',
    'proxy-groups: []',
    'rules:',
    '  - MATCH,DIRECT'
  ].join('\n')
}

function getWindowsTunSelfTestLogs(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /tun|device|error|warning/i.test(line))
    .slice(-12)
}

function getWindowsTunSelfTestFailureMessage(output: string): IWindowsTunSelfTestResult {
  const startTunError = output.match(/Start TUN listening error:\s*(.+)/i)?.[1]?.trim()
  const deviceNotReady = /The device is not ready for use/i.test(output)
  const permissionDenied = /operation not permitted|Access is denied/i.test(output)

  if (deviceNotReady) {
    return {
      status: 'failed',
      message: 'Wintun 设备已尝试创建，但 Windows 没有让设备进入 Ready 状态。',
      error: startTunError || 'The device is not ready for use.',
      requiresRestart: true,
      logs: getWindowsTunSelfTestLogs(output)
    }
  }

  if (permissionDenied) {
    return {
      status: 'failed',
      message: '当前进程没有足够权限创建 TUN 设备。',
      error: startTunError || 'Permission denied.',
      requiresRestart: false,
      logs: getWindowsTunSelfTestLogs(output)
    }
  }

  return {
    status: 'failed',
    message: 'mihomo 无法启动 TUN 监听。',
    error: startTunError || 'Unknown TUN startup error.',
    requiresRestart: false,
    logs: getWindowsTunSelfTestLogs(output)
  }
}

async function stopWindowsTunSelfTestProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return

  await new Promise<void>((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      resolve()
    }

    proc.once('exit', finish)
    proc.kill('SIGINT')
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill()
      }
      finish()
    }, 3000).unref()
  })
}

async function runWindowsTunSelfTest(): Promise<IWindowsTunSelfTestResult> {
  if (process.platform !== 'win32') {
    return {
      status: 'skipped',
      message: '当前平台不需要 Wintun 自检。',
      requiresRestart: false,
      logs: []
    }
  }

  if (!(await checkAdminPrivileges().catch(() => false))) {
    return {
      status: 'skipped',
      message: '当前不是管理员权限，无法验证 TUN 设备是否能真实创建。',
      requiresRestart: false,
      logs: []
    }
  }

  let proc: ChildProcess | null = null
  const workDir = path.join(os.tmpdir(), `clash-party-tun-self-test-${process.pid}-${Date.now()}`)
  const configPath = path.join(workDir, 'config.yaml')
  const device = `ClashPartyTunSelfTest${process.pid}`

  try {
    await mkdir(workDir, { recursive: true })
    await writeFile(configPath, createWindowsTunSelfTestConfig(device), 'utf-8')

    const { core = 'mihomo' } = await getAppConfig()
    const corePath = mihomoCorePath(core)
    if (!existsSync(corePath)) {
      return {
        status: 'failed',
        message: '找不到 mihomo 内核，无法验证 TUN。',
        error: corePath,
        requiresRestart: false,
        logs: []
      }
    }

    try {
      await execFilePromise(corePath, ['-t', '-d', workDir, '-f', configPath])
    } catch (error) {
      const failedOutput = [
        (error as { stdout?: string }).stdout || '',
        (error as { stderr?: string }).stderr || '',
        String(error)
      ].join('\n')

      return {
        status: 'failed',
        message: 'TUN 自检配置无法通过 mihomo 语法校验。',
        error: failedOutput.trim(),
        requiresRestart: false,
        logs: getWindowsTunSelfTestLogs(failedOutput)
      }
    }

    return await new Promise<IWindowsTunSelfTestResult>((resolve) => {
      let output = ''
      let settled = false

      const finish = (result: IWindowsTunSelfTestResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const handleOutput = (chunk: Buffer): void => {
        output += chunk.toString()

        if (isTunStartupReadyLog(output)) {
          finish({
            status: 'passed',
            message: 'TUN 自检通过，mihomo 已能创建并监听 Wintun 设备。',
            requiresRestart: false,
            logs: getWindowsTunSelfTestLogs(output)
          })
          return
        }

        if (/Start TUN listening error/i.test(output)) {
          finish(getWindowsTunSelfTestFailureMessage(output))
        }
      }

      const timer = setTimeout(() => {
        finish({
          status: 'failed',
          message: 'TUN 自检超时，mihomo 没有在限定时间内创建 Wintun 设备。',
          error: 'timeout',
          requiresRestart: true,
          logs: getWindowsTunSelfTestLogs(output)
        })
      }, windowsTunSelfTestTimeoutMs)

      proc = spawn(corePath, ['-d', workDir, '-f', configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildCoreEnv()
      })

      proc.stdout?.on('data', handleOutput)
      proc.stderr?.on('data', handleOutput)
      proc.once('exit', (code, signal) => {
        if (settled) return
        finish({
          status: 'failed',
          message: 'TUN 自检进程提前退出。',
          error: `code=${code}, signal=${signal}`,
          requiresRestart: false,
          logs: getWindowsTunSelfTestLogs(output)
        })
      })
    })
  } finally {
    await stopWindowsTunSelfTestProcess(proc)
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function getWindowsTunDiagnostics(
  options: IWindowsTunDiagnosticsOptions = {}
): Promise<IWindowsTunDiagnostics> {
  const [allProblemDevices, runningServices, isAdmin] = await Promise.all([
    getWindowsProblemNetDevices().catch((error) => {
      managerLogger.warn('Failed to check Windows network problem devices', error)
      return []
    }),
    getRunningWindowsTunServices(),
    checkAdminPrivileges().catch(() => false)
  ])

  const problemDevices = allProblemDevices.filter(isWindowsWintunDevice)
  const networkProblemDevices = allProblemDevices
    .filter((device) => !isWindowsWintunDevice(device))
    .filter(isTunRelevantWindowsNetworkProblemDevice)

  const diagnostics: IWindowsTunDiagnostics = {
    isAdmin,
    problemDevices,
    networkProblemDevices,
    runningServices
  }

  if (options.includeSelfTest) {
    diagnostics.selfTest = await runWindowsTunSelfTest()
  }

  return diagnostics
}

async function assertWindowsWintunReady(offerRepair = false): Promise<void> {
  if (process.platform !== 'win32') return

  try {
    let diagnostics = await getWindowsTunDiagnostics()
    if (!hasBlockingWindowsTunDiagnostics(diagnostics)) return

    if (offerRepair) {
      diagnostics = await repairWindowsTunEnvironment(diagnostics)
      if (!hasBlockingWindowsTunDiagnostics(diagnostics)) return
    }

    throw new Error(
      `检测到 Windows TUN 环境异常，TUN 无法创建：${formatWindowsTunDiagnostics(diagnostics)}。请先修复 Wintun 环境后再开启 TUN。`
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes('检测到 Windows TUN 环境异常')) {
      throw error
    }

    managerLogger.warn('Failed to check Windows Wintun problem devices', error)
  }
}

function createWindowsTunRepairScript(): string {
  return `
$ErrorActionPreference = 'Continue'
for ($pass = 0; $pass -lt 4; $pass++) {
  $output = pnputil.exe /enum-devices /class Net /problem
  $text = $output -join [Environment]::NewLine
  $blocks = $text -split "(?:\\r?\\n){2,}"
  $instanceIds = @()
  foreach ($block in $blocks) {
    if ($block -match "Instance ID:\\s+(SWD\\\\Wintun\\\\[^\\r\\n]+)") {
      $instanceIds += $matches[1].Trim()
    }
  }
  Get-PnpDevice -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match "^SWD\\\\WINTUN\\\\" -and $_.Status -ne "OK" } |
    ForEach-Object { $instanceIds += $_.InstanceId }
  $instanceIds = $instanceIds | Sort-Object -Unique
  if (-not $instanceIds -or $instanceIds.Count -eq 0) {
    break
  }
  foreach ($instanceId in $instanceIds) {
    pnputil.exe /disable-device "$instanceId" /force | Out-Null
    pnputil.exe /remove-device "$instanceId" /subtree /force | Out-Null
    pnputil.exe /remove-device "$instanceId" /force | Out-Null
  }
  Start-Sleep -Seconds 2
}
pnputil.exe /restart-device "ROOT\\VMS_VSMP\\0000" | Out-Null
pnputil.exe /scan-devices | Out-Null
Start-Sleep -Seconds 2
`
}

async function runWindowsTunRepairScriptElevated(script: string): Promise<void> {
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')

  if (await checkAdminPrivileges()) {
    await execFilePromise('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedScript
    ])
    return
  }

  const startProcessCommand = [
    '$argsList = @(',
    "'-NoProfile',",
    "'-ExecutionPolicy',",
    "'Bypass',",
    "'-EncodedCommand',",
    `'${encodedScript}'`,
    ');',
    "Start-Process -FilePath 'powershell.exe' -ArgumentList $argsList -Verb RunAs -Wait -WindowStyle Hidden"
  ].join(' ')

  await execFilePromise('powershell.exe', ['-NoProfile', '-Command', startProcessCommand])
}

export async function repairWindowsTunEnvironment(
  initialDiagnostics?: IWindowsTunDiagnostics
): Promise<IWindowsTunDiagnostics> {
  if (process.platform !== 'win32') {
    return getWindowsTunDiagnostics()
  }

  const diagnostics =
    initialDiagnostics || (await getWindowsTunDiagnostics({ includeSelfTest: true }))
  if (!hasBlockingWindowsTunDiagnostics(diagnostics)) {
    return diagnostics
  }

  const confirmText = i18next.t('common.confirm') || '确认'
  const cancelText = i18next.t('common.cancel') || '取消'
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: i18next.t('tun.wintunRepair.confirmTitle') || '修复 Wintun 环境',
    message:
      i18next.t('tun.wintunRepair.confirmMessage') || '将删除异常 Wintun 虚拟网卡，继续？',
    detail: formatWindowsTunDiagnostics(diagnostics),
    buttons: [confirmText, cancelText],
    defaultId: 0,
    cancelId: 1
  })

  if (choice !== 0) {
    return diagnostics
  }

  await runWindowsTunRepairScriptElevated(createWindowsTunRepairScript())
  await new Promise((resolve) => setTimeout(resolve, 2000))
  return getWindowsTunDiagnostics({ includeSelfTest: true })
}

async function disableTunAfterStartupError(message: string): Promise<void> {
  managerLogger.warn(`TUN startup failed, disabling TUN config: ${message}`)
  await patchControledMihomoConfig({ tun: { enable: false } }, { hotPatch: false })
  notifyControledMihomoConfigUpdated()
}

// 初始化核心文件监听
export function initCoreWatcher(): void {
  if (coreWatcher) return

  coreWatcher = chokidar.watch(path.join(mihomoCoreDir(), 'meta-update'), {})
  coreWatcher.on('unlinkDir', async () => {
    // 等待核心自我更新完成，避免与核心自动重启产生竞态
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      await restartCore(true)
    } catch (e) {
      safeShowErrorBox('mihomo.error.coreStartFailed', `${e}`)
    }
  })

  // 监听 restartCore 事件（用于 DNS 状态恢复等场景，避免循环依赖）
  ipcMain.removeAllListeners('restartCore')
  ipcMain.on('restartCore', async () => {
    await restartCore()
    mainWindow?.webContents.send('appConfigUpdated')
  })
}

// 清理核心文件监听
export function cleanupCoreWatcher(): void {
  if (coreWatcher) {
    coreWatcher.close()
    coreWatcher = null
  }
}

// 动态生成 IPC 路径
export const getMihomoIpcPath = (): string => {
  if (process.platform === 'win32') {
    const isAdmin = getSessionAdminStatus()
    const sessionId = process.env.SESSIONNAME || process.env.USERNAME || 'default'
    const processId = process.pid

    return isAdmin
      ? `\\\\.\\pipe\\MihomoParty\\mihomo-admin-${sessionId}-${processId}`
      : `\\\\.\\pipe\\MihomoParty\\mihomo-user-${sessionId}-${processId}`
  }

  const uid = process.getuid?.() || 'unknown'
  const processId = process.pid
  return `/tmp/mihomo-party-${uid}-${processId}.sock`
}

// 核心配置接口
interface CoreConfig {
  corePath: string
  workDir: string
  safePath?: string
  ipcPath: string
  logLevel: LogLevel
  tunEnabled: boolean
  autoSetDNS: boolean
  cpuPriority: string
  ageSecretKey?: string
  detached: boolean
  startupMode: CoreStartupMode
  startupHook?: CoreStartupHook
}

function buildCoreEnv(safePath?: string, ageSecretKey?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const normalizedAgeSecretKey = parseAgeSecretKeys(ageSecretKey).join('\n')
  if (normalizedAgeSecretKey) {
    env.CLASH_AGE_SECRET_KEY = normalizedAgeSecretKey
  }
  if (!safePath) return env

  const existingSafePaths = env.SAFE_PATHS?.split(path.delimiter).filter(Boolean) ?? []
  env.SAFE_PATHS = existingSafePaths.includes(safePath)
    ? existingSafePaths.join(path.delimiter)
    : [...existingSafePaths, safePath].join(path.delimiter)
  return env
}

// 准备核心配置
async function prepareCore(detached: boolean, skipStop = false): Promise<CoreConfig> {
  await ensureRuntimeFiles()

  const [appConfig, mihomoConfig] = await Promise.all([getAppConfig(), getControledMihomoConfig()])

  const {
    core = 'mihomo',
    autoSetDNS = true,
    diffWorkDir = false,
    mihomoCpuPriority = 'PRIORITY_NORMAL',
    coreStartupMode = 'log',
    testProfileOnStart = true
  } = appConfig

  const { 'log-level': logLevel = 'info' as LogLevel, tun } = mihomoConfig

  // 清理轻量模式遗留的后台核心
  await stopPidFileCore()

  // 管理 Smart 内核覆写配置
  await manageSmartOverride()

  // generateProfile 返回实际使用的 current
  const current = await generateProfile()
  const ageSecretKey = (await getProfileItem(current))?.ageSecretKey || ''
  if (testProfileOnStart) {
    await checkProfile(current, core, diffWorkDir, ageSecretKey)
  }
  if (!skipStop && hasCoreProcess()) {
    await stopCoreInternal()
  }
  await cleanupSocketFile()

  // 设置 DNS
  if (tun?.enable && autoSetDNS) {
    ensureNotShuttingDown()
    try {
      await setPublicDNS()
    } catch (error) {
      managerLogger.error('set dns failed', error)
    }
    ensureNotShuttingDown()
  }

  // 获取动态 IPC 路径
  const ipcPath = getMihomoIpcPath()
  managerLogger.info(`Using IPC path: ${ipcPath}`)

  if (process.platform === 'win32') {
    await validateWindowsPipeAccess(ipcPath)
  }

  const startupMode: CoreStartupMode = coreStartupMode === 'post-up' ? 'post-up' : 'log'
  const startupHook =
    !detached && startupMode === 'post-up' ? await createCoreStartupHook() : undefined

  return {
    corePath: mihomoCorePath(core),
    workDir: diffWorkDir ? mihomoProfileWorkDir(current) : mihomoWorkDir(),
    safePath: diffWorkDir ? mihomoWorkDir() : undefined,
    ipcPath,
    logLevel,
    tunEnabled: tun?.enable ?? false,
    autoSetDNS,
    cpuPriority: mihomoCpuPriority,
    ageSecretKey,
    detached,
    startupMode,
    startupHook
  }
}

// 启动核心进程
function spawnCoreProcess(config: CoreConfig): ChildProcess {
  const {
    corePath,
    workDir,
    safePath,
    ipcPath,
    cpuPriority,
    ageSecretKey,
    detached,
    startupMode,
    startupHook
  } = config

  const args = ['-d', workDir, ctlParam, ipcPath]
  if (startupHook) {
    args.push('-post-up', startupHook.postUpCommand, '-post-down', startupHook.postDownCommand)
    managerLogger.info(`Core startup mode: post-up, post-up command: ${startupHook.postUpCommand}`)
  } else if (!detached) {
    managerLogger.info(`Core startup mode: ${startupMode}`)
  }

  const proc = spawn(corePath, args, {
    detached,
    stdio: detached ? 'ignore' : undefined,
    env: buildCoreEnv(safePath, ageSecretKey)
  })

  if (process.platform === 'win32' && proc.pid) {
    os.setPriority(
      proc.pid,
      os.constants.priority[cpuPriority as keyof typeof os.constants.priority]
    )
  }

  if (!detached) {
    const stdout = createCoreLogWritableStream(coreLogPath)
    const stderr = createCoreLogWritableStream(coreLogPath)
    proc.stdout?.pipe(stdout)
    proc.stderr?.pipe(stderr)
  }

  return proc
}

// 设置核心进程事件监听
function setupCoreListeners(
  proc: ChildProcess,
  config: CoreConfig,
  hookWaiter: CoreHookWaiter | undefined,
  resolve: (value: Promise<void>[]) => void,
  reject: (reason: unknown) => void
): void {
  const { logLevel, startupMode } = config
  let startupSettled = false
  const startupTimer =
    startupMode === 'log'
      ? setTimeout(() => {
          rejectStartup(new Error(`Timed out waiting for core API readiness: ${coreHookTimeout}ms`))
        }, coreHookTimeout)
      : undefined

  const resolveStartup = (value: Promise<void>[]): void => {
    if (startupSettled) return
    startupSettled = true
    if (startupTimer) clearTimeout(startupTimer)
    resolve(value)
  }

  const rejectStartup = (reason: unknown): void => {
    if (startupSettled) return
    startupSettled = true
    if (startupTimer) clearTimeout(startupTimer)
    reject(reason)
  }

  const startMihomoApiStreams = async (): Promise<void> => {
    await waitForCoreReady()
    await getAxios(true)
    await Promise.all([
      startMihomoTraffic(),
      startMihomoConnections(),
      startMihomoLogs(),
      startMihomoMemory()
    ])
  }

  const completeCoreStartup = async (): Promise<void> => {
    try {
      mainWindow?.webContents.send('groupsUpdated')
      mainWindow?.webContents.send('rulesUpdated')
      await uploadRuntimeConfigIfChanged()
    } catch (error) {
      managerLogger.warn('Failed to sync runtime config to Gist', error)
    }
    await patchMihomoConfig({ 'log-level': logLevel })
  }

  proc.on('close', async (code, signal) => {
    managerLogger.info(`Core closed, code: ${code}, signal: ${signal}`)
    stopCoreProcessWatchdog(proc.pid)

    if (child === proc) {
      child = null
    }

    if (coreOperationPhase === 'shutting-down') {
      rejectStartup(new Error('Core closed because the application is shutting down'))
      return
    }

    if (isRestarting) {
      managerLogger.info('Core closed during restart, skipping auto-restart')
      rejectStartup(new Error('Core startup was interrupted by restart'))
      return
    }

    if (coreOperationPhase === 'ready') {
      managerLogger.info('Try Restart Core after unexpected exit')
      try {
        await restartCoreAfterUnexpectedExit()
        resolveStartup([])
      } catch (error) {
        managerLogger.error('Automatic core recovery failed', error)
        rejectStartup(error)
      }
    } else {
      await runCoreOperation(() => stopCoreInternal())
      rejectStartup(new Error(`Core exited before startup completed, code: ${code}`))
    }
  })

  proc.stdout?.on('data', async (data) => {
    const str = data.toString()

    if (isTunStartupReadyLog(str)) {
      resolveTunStartupWaiter()
    }

    const tunStartupErrorMessage = getTunStartupErrorMessage(str)
    if (tunStartupErrorMessage) {
      const handledByTunToggle = rejectTunStartupWaiter(tunStartupErrorMessage)
      if (!handledByTunToggle) {
        try {
          await disableTunAfterStartupError(tunStartupErrorMessage)
        } catch (error) {
          managerLogger.warn('Failed to disable TUN after startup error', error)
        }
      }
      rejectStartup(tunStartupErrorMessage)
      return
    }

    // 控制器监听错误
    const isControllerError =
      (process.platform !== 'win32' && str.includes('External controller unix listen error')) ||
      (process.platform === 'win32' && str.includes('External controller pipe listen error'))

    if (isControllerError) {
      managerLogger.error('External controller listen error detected:', str)

      if (process.platform === 'win32') {
        managerLogger.info('Attempting Windows pipe cleanup and retry...')
        try {
          await cleanupWindowsNamedPipes(true)
          await new Promise((r) => setTimeout(r, 2000))
        } catch (cleanupError) {
          managerLogger.error('Pipe cleanup failed:', cleanupError)
        }
      }

      rejectStartup(i18next.t('mihomo.error.externalControllerListenError'))
      return
    }

    if (startupMode === 'post-up') {
      return
    }

    // API 就绪
    const isApiReady =
      (process.platform !== 'win32' && str.includes('RESTful API unix listening at')) ||
      (process.platform === 'win32' && str.includes('RESTful API pipe listening at'))

    if (isApiReady) {
      resolveStartup([
        new Promise((innerResolve) => {
          proc.stdout?.on('data', async (innerData) => {
            if (
              innerData
                .toString()
                .toLowerCase()
                .includes('start initial compatible provider default')
            ) {
              completeCoreStartup()
                .then(() => innerResolve())
                .catch((error) => {
                  managerLogger.warn('Failed to complete core startup', error)
                  innerResolve()
                })
            }
          })
        })
      ])

      await startMihomoApiStreams()
    }
  })

  if (startupMode === 'post-up') {
    if (!hookWaiter) {
      rejectStartup(new Error('Core post-up startup mode requires a startup hook'))
      return
    }

    hookWaiter.promise
      .then(async () => {
        managerLogger.info('Core post-up hook triggered')
        await startMihomoApiStreams()
        resolveStartup([completeCoreStartup()])
      })
      .catch(rejectStartup)
  }

  cancelActiveStartup = (reason) => rejectStartup(reason)
}

interface CoreStartAttempt {
  readiness: Promise<Promise<void>[]>
}

async function startCoreInternal(detached = false, skipStop = false): Promise<CoreStartAttempt> {
  ensureNotShuttingDown()
  const config = await prepareCore(detached, skipStop)
  ensureNotShuttingDown()
  const hookWaiter = config.startupHook ? createCoreHookWaiter(config.startupHook) : undefined
  const proc = spawnCoreProcess(config)
  hookWaiter?.attachProcess(proc)
  child = proc
  startCoreProcessWatchdog(proc, detached)

  if (detached) {
    managerLogger.info(
      `Core process detached successfully on ${process.platform}, PID: ${proc.pid}`
    )
    proc.unref()
    return { readiness: Promise.resolve([new Promise(() => {})]) }
  }

  const readiness = new Promise<Promise<void>[]>((resolve, reject) => {
    setupCoreListeners(proc, config, hookWaiter, resolve, reject)
  })
  const activeCancel = cancelActiveStartup
  readiness.then(
    () => {
      if (cancelActiveStartup === activeCancel) cancelActiveStartup = null
    },
    () => {
      if (cancelActiveStartup === activeCancel) cancelActiveStartup = null
    }
  )

  return {
    readiness
  }
}

// 互斥只覆盖 prepare/spawn；API-ready 等待在队列外进行，避免 close handler 自重启死锁。
function queueCoreStart(detached = false, skipStop = false): Promise<Promise<void>[]> {
  return runCoreOperation(async () => {
    ensureNotShuttingDown()
    if (!detached && !skipStop && hasCoreProcess()) {
      return { readiness: Promise.resolve<Promise<void>[]>([]) }
    }
    return startCoreInternal(detached, skipStop)
  }).then((attempt) => attempt.readiness)
}

export function startCore(detached = false, skipStop = false): Promise<Promise<void>[]> {
  ensureCoreOperationAllowed()
  return queueCoreStart(detached, skipStop)
}

// 启动期唯一的例外入口：安全检查通过后由主流程调用，仍受退出状态保护。
export function startCoreForStartup(): Promise<Promise<void>[]> {
  if (coreOperationPhase === 'blocked') {
    throw new Error('Core startup is unavailable because startup safety checks did not pass')
  }
  ensureNotShuttingDown()
  return queueCoreStart()
}

async function stopCoreInternal(force = false, cancelStartup = true): Promise<void> {
  if (!force && process.platform === 'darwin') {
    try {
      await recoverDNS()
    } catch (error) {
      managerLogger.error('recover dns failed', error)
    }
  }

  stopCoreProcessAndStreams(cancelStartup)

  await cleanupStoppedCoreResources()
}

function stopCoreProcessAndStreams(cancelStartup = true): void {
  if (cancelStartup) {
    cancelActiveStartup?.(new Error('Core startup was cancelled by a stop request'))
    cancelActiveStartup = null
  }
  if (child) {
    child.removeAllListeners()
    child.kill('SIGINT')
    child = null
  }

  stopCoreProcessWatchdog()

  stopMihomoTraffic()
  stopMihomoConnections()
  stopMihomoLogs()
  stopMihomoMemory()
}

async function cleanupStoppedCoreResources(): Promise<void> {
  try {
    await getAxios(true)
  } catch (error) {
    managerLogger.warn('Failed to refresh axios instance:', error)
  }

  await stopPidFileCore()
  await cleanupSocketFile()
}

export async function stopCore(force = false): Promise<void> {
  ensureCoreOperationAllowed()
  cancelAutomaticRestart()
  return runCoreOperation(() => stopCoreInternal(force))
}

// 退出不排队等待启动/重启完成：先同步终止子进程，再做有界清理。
export async function stopCoreForExit(): Promise<void> {
  coreOperationPhase = 'shutting-down'
  cancelAutomaticRestart()
  stopCoreProcessAndStreams()
  await Promise.allSettled([
    recoverDNS({ force: true, timeout: 750 }),
    cleanupStoppedCoreResources()
  ])
}

setStopCoreBeforeAdminRestart(stopCore)

export async function setTunMode(enable: boolean): Promise<void> {
  if (tunModeOperation) {
    throw new Error('TUN 正在切换中，请等待当前操作完成')
  }

  const operation = setTunModeInternal(enable)
  tunModeOperation = operation

  try {
    await operation
  } finally {
    if (tunModeOperation === operation) {
      tunModeOperation = null
    }
  }
}

async function setTunModeInternal(enable: boolean): Promise<void> {
  const previousConfig = await getControledMihomoConfig()
  const previousTun = { ...(previousConfig.tun || {}) }
  const previousTunEnabled = previousConfig.tun?.enable ?? false
  const previousDnsEnabled = previousConfig.dns?.enable
  const nextPatch: Partial<IMihomoConfig> = enable
    ? { tun: { ...previousTun, enable }, dns: { enable: true } }
    : { tun: { ...previousTun, enable } }

  if (enable) {
    await assertWindowsWintunReady(true)
  }

  setTunStatusOverride(previousTunEnabled)

  try {
    await patchControledMihomoConfig(nextPatch, { hotPatch: false })

    try {
      await restartCoreAndWaitForTun(enable)
    } catch (error) {
      const fallbackDevice = getTunDeviceFallbackName(previousTun.device)
      const fallbackStack = getTunStackFallbackName(previousTun.stack)
      if (!enable || (!fallbackDevice && !fallbackStack) || !shouldRetryTunWithFallback(error)) {
        throw error
      }

      managerLogger.warn(
        `TUN startup failed with device ${previousTun.device || 'Mihomo'} and stack ${previousTun.stack || 'mixed'}, retrying with device ${fallbackDevice || previousTun.device || 'Mihomo'} and stack ${fallbackStack || previousTun.stack || 'mixed'}`,
        error
      )
      await patchControledMihomoConfig(
        {
          tun: {
            ...previousTun,
            enable: true,
            ...(fallbackDevice ? { device: fallbackDevice } : {}),
            ...(fallbackStack ? { stack: fallbackStack } : {})
          },
          dns: { enable: true }
        },
        { hotPatch: false }
      )
      await restartCoreAndWaitForTun(true)
    }

    const currentConfig = await getControledMihomoConfig(true)
    if ((currentConfig.tun?.enable ?? false) !== enable) {
      throw new Error(enable ? 'TUN start failed' : 'TUN stop failed')
    }

    setTunStatusOverride(null)
    notifyControledMihomoConfigUpdated()
  } catch (error) {
    const rollbackPatch: Partial<IMihomoConfig> = {
      tun: { ...previousTun, enable: previousTunEnabled }
    }

    if (typeof previousDnsEnabled === 'boolean') {
      rollbackPatch.dns = { enable: previousDnsEnabled }
    }

    try {
      await patchControledMihomoConfig(rollbackPatch, { hotPatch: false })
      await restartCore()
      setTunStatusOverride(null)
      notifyControledMihomoConfigUpdated()
    } catch (rollbackError) {
      setTunStatusOverride(null)
      managerLogger.error('Failed to rollback TUN mode after toggle failure', rollbackError)
    }

    throw error
  }
}

async function restartCoreOnce(forceStop: boolean): Promise<void> {
  const startAttempt = await runCoreOperation(async () => {
    await stopCoreInternal(forceStop)
    return startCoreInternal(false, true)
  })
  await startAttempt.readiness
}

function trackCoreRestart(operation: () => Promise<void>): Promise<void> {
  if (pendingRestart) return pendingRestart

  isRestarting = true
  const restart = operation().finally(() => {
    isRestarting = false
    if (pendingRestart === restart) pendingRestart = null
  })
  pendingRestart = restart
  return restart
}

async function restartCoreAfterUnexpectedExit(): Promise<void> {
  ensureCoreOperationAllowed()
  const controller = new AbortController()
  automaticRestartController = controller
  try {
    await trackCoreRestart(async () => {
      try {
        await restartCoreOnce(true)
      } catch (error) {
        if (controller.signal.aborted || coreOperationPhase === 'shutting-down') throw error

        managerLogger.warn('Automatic core restart failed (attempt 1/2), retrying', error)
        await delay(automaticRestartDelay, undefined, { signal: controller.signal })
        await restartCoreOnce(true)
      }
    })
  } finally {
    if (automaticRestartController === controller) automaticRestartController = null
  }
}

export function restartCore(forceStop = false): Promise<void> {
  ensureCoreOperationAllowed()
  return trackCoreRestart(() => restartCoreOnce(forceStop))
}

// 保持核心运行
export async function keepCoreAlive(): Promise<boolean> {
  try {
    await startCore(true)
    if (child?.pid) {
      await writeFile(path.join(dataDir(), 'core.pid'), child.pid.toString())
    }
    return Boolean(child?.pid)
  } catch (e) {
    safeShowErrorBox('mihomo.error.coreStartFailed', `${e}`)
    return false
  }
}

// 退出但保持核心运行
export async function quitWithoutCore(): Promise<void> {
  managerLogger.info(`Starting lightweight mode on platform: ${process.platform}`)
  if (!(await keepCoreAlive())) return
  await startMonitor(true)
  managerLogger.info('Exiting main process, core will continue running in background')
  app.exit()
}

// 检查配置文件
async function checkProfile(
  current: string | undefined,
  core: string = 'mihomo',
  diffWorkDir: boolean = false,
  ageSecretKey?: string
): Promise<void> {
  await checkProfileConfig(
    diffWorkDir ? mihomoWorkConfigPath(current) : mihomoWorkConfigPath('work'),
    core,
    ageSecretKey
  )
}

export async function checkProfileConfig(
  configPath: string,
  core: string = 'mihomo',
  ageSecretKey?: string
): Promise<void> {
  const corePath = mihomoCorePath(core)

  try {
    await execFilePromise(corePath, ['-t', '-f', configPath, '-d', mihomoTestDir()], {
      env: buildCoreEnv(undefined, ageSecretKey)
    })
  } catch (error) {
    managerLogger.error('Profile check failed', error)

    if (error instanceof Error && 'stdout' in error) {
      const { stdout, stderr } = error as { stdout: string; stderr?: string }
      managerLogger.info('Profile check stdout', stdout)
      managerLogger.info('Profile check stderr', stderr)

      const errorLines = stdout
        .split('\n')
        .filter((line) => line.includes('level=error') || line.includes('error'))
        .map((line) => {
          if (line.includes('level=error')) {
            return line.split('level=error')[1]?.trim() || line
          }
          return line.trim()
        })
        .filter((line) => line.length > 0)

      if (errorLines.length === 0) {
        const allLines = stdout.split('\n').filter((line) => line.trim().length > 0)
        throw new Error(`${i18next.t('mihomo.error.profileCheckFailed')}:\n${allLines.join('\n')}`)
      } else {
        throw new Error(
          `${i18next.t('mihomo.error.profileCheckFailed')}:\n${errorLines.join('\n')}`
        )
      }
    } else {
      throw new Error(`${i18next.t('mihomo.error.profileCheckFailed')}: ${error}`)
    }
  }
}

// 权限检查入口（从 permissions.ts 调用）
export async function checkAdminRestartForTun(): Promise<void> {
  await checkAdminRestartForTunWithRestart(restartCore)
}
