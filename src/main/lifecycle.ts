import { spawn, exec, execFileSync } from 'child_process'
import { promisify } from 'util'
import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { app, powerMonitor } from 'electron'
import { stopCoreForExit, cleanupCoreWatcher } from './core/manager'
import { primeAdminPrivilegesCache } from './core/admin'
import { triggerSysProxy, disableSysProxySync } from './sys/sysproxy'
import { exePath } from './utils/dirs'
import { saveMainWindowState } from './window'
import { systemLogger } from './utils/logger'

export function customRelaunch(): void {
  const script = `while kill -0 ${process.pid} 2>/dev/null; do
  sleep 0.1
done
${process.argv.join(' ')} & disown
exit
`
  spawn('sh', ['-c', script], {
    detached: true,
    stdio: 'ignore'
  })
}

export async function fixUserDataPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  const userDataPath = app.getPath('userData')
  if (!existsSync(userDataPath)) return

  try {
    const stats = await stat(userDataPath)
    const currentUid = process.getuid?.() || 0

    if (stats.uid === 0 && currentUid !== 0) {
      const execPromise = promisify(exec)
      const username = process.env.USER || process.env.LOGNAME
      if (username) {
        await execPromise(`chown -R "${username}:staff" "${userDataPath}"`)
        await execPromise(`chmod -R u+rwX "${userDataPath}"`)
      }
    }
  } catch {
    // ignore
  }
}

export function setupPlatformSpecifics(): void {
  if (process.platform === 'linux') {
    app.relaunch = customRelaunch
  }

  // https://github.com/electron/electron/issues/43278
  // https://github.com/electron/electron/issues/36698
  const electronMajor = parseInt(process.versions.electron.split('.')[0], 10) || 0
  if (process.platform === 'win32' && !exePath().startsWith('C') && electronMajor < 38) {
    app.commandLine.appendSwitch('in-process-gpu')
  }

  if (process.platform === 'win32') {
    const elevated = isWindowsElevatedSync()
    if (elevated === true) {
      primeAdminPrivilegesCache(true)
      app.commandLine.appendSwitch('disable-gpu-sandbox')
    }
  }
}

function isWindowsElevatedSync(): boolean | null {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('fltmc', [], { stdio: 'ignore', windowsHide: true, timeout: 800 })
    return true
  } catch {
    // 只有成功结果可安全缓存；所有失败交给异步 fltmc + net session 回退确认。
    return null
  }
}

export function setupAppLifecycle(): void {
  let sysProxyDisabled = false
  let cleanupPromise: Promise<void> | null = null

  const withTimeout = async (promise: Promise<void>, timeout: number): Promise<void> => {
    let timeoutId: NodeJS.Timeout | null = null

    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, timeout)
        })
      ])
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  const cleanupBeforeExit = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise

    cleanupPromise = (async () => {
      try {
        saveMainWindowState() // 硬退出补一次落盘
      } catch (error) {
        void systemLogger.error('Failed to persist main window state during exit', error)
      }

      try {
        cleanupCoreWatcher()
      } catch (error) {
        void systemLogger.error('Failed to clean up core watcher during exit', error)
      }

      if (process.platform !== 'darwin') {
        try {
          disableSysProxySync()
          sysProxyDisabled = true
        } catch (error) {
          void systemLogger.error('Failed to disable system proxy sync during exit', error)
        }
      }

      const cleanupTasks: Promise<unknown>[] = [
        stopCoreForExit().catch((error) => {
          void systemLogger.error('Failed to stop core during exit', error)
        })
      ]
      if (process.platform === 'darwin') {
        cleanupTasks.push(
          triggerSysProxy(false, { helperTimeout: 750, force: true })
            .then(() => {
              sysProxyDisabled = true
            })
            .catch((error) => {
              void systemLogger.error('Failed to disable system proxy during exit', error)
            })
        )
      }

      await withTimeout(Promise.allSettled(cleanupTasks).then(() => {}), 1200)
    })()

    return cleanupPromise
  }

  app.on('window-all-closed', () => {
    // Keep the app and tray alive when lightweight tray mode destroys the renderer window.
  })

  // Windows 注销/关机可能先触发窗口 session-end；复用同一清理 Promise，
  // 避免与 powerMonitor.shutdown 重复执行普通、无界的核心和代理清理。
  app.on('browser-window-created', (_event, window) => {
    window.on('session-end', async () => {
      try {
        await cleanupBeforeExit()
      } finally {
        app.exit()
      }
    })
  })
  app.on('before-quit', async (e) => {
    e.preventDefault()
    try {
      await cleanupBeforeExit()
    } finally {
      app.exit()
    }
  })

  powerMonitor.on('shutdown', async () => {
    try {
      await cleanupBeforeExit()
    } finally {
      app.exit()
    }
  })

  app.on('will-quit', () => {
    if (!sysProxyDisabled) {
      try {
        disableSysProxySync()
      } catch (error) {
        void systemLogger.error('Failed to disable system proxy sync during will-quit', error)
      }
    }
  })
}

export function getSystemLanguage(): 'zh-CN' | 'en-US' {
  const locale = app.getLocale()
  return locale.startsWith('zh') ? 'zh-CN' : 'en-US'
}
