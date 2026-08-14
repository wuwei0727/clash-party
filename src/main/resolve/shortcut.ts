import { app, globalShortcut, ipcMain, Notification } from 'electron'
import { mainWindow, triggerMainWindow } from '../window'
import {
  getAppConfig,
  getControledMihomoConfig,
  patchControledMihomoConfig
} from '../config'
import { setSysProxyEnabled } from '../sys/sysproxy'
import { quitWithoutCore, setTunMode } from '../core/manager'
import i18next from '../../shared/i18n'
import { floatingWindow, triggerFloatingWindow } from './floatingWindow'
import { copyEnv, refreshTrayUi, updateTrayIcon } from './tray'

export async function registerShortcut(
  oldShortcut: string,
  newShortcut: string,
  action: string
): Promise<boolean> {
  if (oldShortcut !== '') {
    globalShortcut.unregister(oldShortcut)
  }
  if (newShortcut === '') {
    return true
  }
  switch (action) {
    case 'showWindowShortcut': {
      return globalShortcut.register(newShortcut, () => {
        triggerMainWindow(true)
      })
    }
    case 'showFloatingWindowShortcut': {
      return globalShortcut.register(newShortcut, async () => {
        await triggerFloatingWindow()
      })
    }
    case 'triggerSysProxyShortcut': {
      return globalShortcut.register(newShortcut, async () => {
        const {
          sysProxy: { enable: previousEnable }
        } = await getAppConfig()
        const targetEnable = !previousEnable
        let succeeded = false

        try {
          succeeded = await setSysProxyEnabled(targetEnable)
          if (!succeeded) return
          new Notification({
            title: i18next.t(
              targetEnable
                ? 'common.notification.systemProxyEnabled'
                : 'common.notification.systemProxyDisabled'
            )
          }).show()
        } catch {
          // setSysProxyEnabled performs configuration and native-state rollback.
        } finally {
          mainWindow?.webContents.send('appConfigUpdated')
          floatingWindow?.webContents.send('appConfigUpdated')
          await refreshTrayUi()
        }
      })
    }
    case 'triggerTunShortcut': {
      return globalShortcut.register(newShortcut, async () => {
        const { tun } = await getControledMihomoConfig()
        const targetEnable = !(tun?.enable ?? false)
        try {
          await setTunMode(targetEnable)
          new Notification({
            title: i18next.t(
              targetEnable ? 'common.notification.tunEnabled' : 'common.notification.tunDisabled'
            )
          }).show()
        } catch {
          // setTunMode performs its own config/core rollback.
        } finally {
          mainWindow?.webContents.send('controledMihomoConfigUpdated')
          floatingWindow?.webContents.send('controledMihomoConfigUpdated')
          await refreshTrayUi()
        }
      })
    }
    case 'ruleModeShortcut': {
      return globalShortcut.register(newShortcut, async () => {
        await patchControledMihomoConfig({ mode: 'rule' })
        new Notification({
          title: i18next.t('common.notification.ruleMode')
        }).show()
        mainWindow?.webContents.send('controledMihomoConfigUpdated')
        ipcMain.emit('updateTrayMenu')
        await updateTrayIcon()
      })
    }
    case 'globalModeShortcut': {
      return globalShortcut.register(newShortcut, async () => {
        await patchControledMihomoConfig({ mode: 'global' })
        new Notification({
          title: i18next.t('common.notification.globalMode')
        }).show()
        mainWindow?.webContents.send('controledMihomoConfigUpdated')
        ipcMain.emit('updateTrayMenu')
        await updateTrayIcon()
      })
    }
    case 'directModeShortcut': {
      return globalShortcut.register(newShortcut, async () => {
        await patchControledMihomoConfig({ mode: 'direct' })
        new Notification({
          title: i18next.t('common.notification.directMode')
        }).show()
        mainWindow?.webContents.send('controledMihomoConfigUpdated')
        ipcMain.emit('updateTrayMenu')
        await updateTrayIcon()
      })
    }
    case 'quitWithoutCoreShortcut': {
      return globalShortcut.register(newShortcut, async () => {
        await quitWithoutCore()
      })
    }
    case 'restartAppShortcut': {
      return globalShortcut.register(newShortcut, () => {
        app.relaunch()
        app.quit()
      })
    }
    case 'copyEnvShortcut': {
      return globalShortcut.register(newShortcut, async () => {
        const shellType = process.platform === 'win32' ? 'powershell' : 'bash'
        await copyEnv(shellType)
        new Notification({
          title: i18next.t('common.notification.copyEnvSuccess')
        }).show()
      })
    }
  }
  throw new Error('Unknown action')
}

export async function initShortcut(): Promise<void> {
  const {
    showFloatingWindowShortcut,
    showWindowShortcut,
    triggerSysProxyShortcut,
    triggerTunShortcut,
    ruleModeShortcut,
    globalModeShortcut,
    directModeShortcut,
    quitWithoutCoreShortcut,
    restartAppShortcut,
    copyEnvShortcut
  } = await getAppConfig()
  if (showWindowShortcut) {
    try {
      await registerShortcut('', showWindowShortcut, 'showWindowShortcut')
    } catch {
      // ignore
    }
  }
  if (showFloatingWindowShortcut) {
    try {
      await registerShortcut('', showFloatingWindowShortcut, 'showFloatingWindowShortcut')
    } catch {
      // ignore
    }
  }
  if (triggerSysProxyShortcut) {
    try {
      await registerShortcut('', triggerSysProxyShortcut, 'triggerSysProxyShortcut')
    } catch {
      // ignore
    }
  }
  if (triggerTunShortcut) {
    try {
      await registerShortcut('', triggerTunShortcut, 'triggerTunShortcut')
    } catch {
      // ignore
    }
  }
  if (ruleModeShortcut) {
    try {
      await registerShortcut('', ruleModeShortcut, 'ruleModeShortcut')
    } catch {
      // ignore
    }
  }
  if (globalModeShortcut) {
    try {
      await registerShortcut('', globalModeShortcut, 'globalModeShortcut')
    } catch {
      // ignore
    }
  }
  if (directModeShortcut) {
    try {
      await registerShortcut('', directModeShortcut, 'directModeShortcut')
    } catch {
      // ignore
    }
  }
  if (quitWithoutCoreShortcut) {
    try {
      await registerShortcut('', quitWithoutCoreShortcut, 'quitWithoutCoreShortcut')
    } catch {
      // ignore
    }
  }
  if (restartAppShortcut) {
    try {
      await registerShortcut('', restartAppShortcut, 'restartAppShortcut')
    } catch {
      // ignore
    }
  }
  if (copyEnvShortcut) {
    try {
      await registerShortcut('', copyEnvShortcut, 'copyEnvShortcut')
    } catch {
      // ignore
    }
  }
}
